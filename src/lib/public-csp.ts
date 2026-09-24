import {
  DOMAIN_RE,
  hashScripts,
  parseScriptsApproval,
  scriptHosts,
  type ScriptSourceLike,
} from "@/ext/dx/scripts-core";
import {
  SCRIPTS_STAMP_SQL,
  readStampsFromKv,
  readStampsRecordFromD1,
  refreshStamps,
  scriptsStampFromRow,
  type KvTarget,
  type ScriptsStampRow,
  type StampsRecord,
} from "./stamps";

// [core] 公開頁 CSP 的主機白名單:啟用中、而且核准紀錄對得上目前內容的宣告式插件
// scripts,它們的 src 主機與宣告的 domains。判斷與 ext/dx/scripts-widget.tsx 同一條
// (hash 對不上就不渲染 = 也不放行)。
//
// 在 middleware(edge)裡跑,所以只用 D1 binding 與零依賴的 scripts-core —— 不拉
// drizzle、zod、loader。manifest 裡的 scripts 安裝時已經過 zod;這裡只做「形狀對、
// 值合規」的最小檢查,因為結果會寫進回應標頭。
//
// 1.51.0:插件的前台編進了網站(public:scripts)時,它的 scripts 不會輸出,主機也不該
// 在白名單上。middleware 是另一個 bundle,看不到編進來的程式碼 —— 靠的是「被取代的
// script 沒有核准紀錄」:安裝時清掉、不能再核准、編進去之前的由 loader 清掉
// (ext/dx/scripts-compiled.ts)。所以這裡照舊只看核准。編進來的元件是 bundle 裡的
// 程式,'self' 就涵蓋,不用放行任何主機。

const SQL = `SELECT json_extract(manifest, '$.scripts') AS scripts, scripts_approval AS approval
  FROM declarative_extensions
  WHERE enabled = 1 AND scripts_approval IS NOT NULL`;

interface Row {
  scripts: string | null;
  approval: string | null;
}

function asScripts(raw: string | null): ScriptSourceLike[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ScriptSourceLike[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { src, inline, domains } = item as Record<string, unknown>;
    if (src !== undefined && typeof src !== "string") return null;
    if (inline !== undefined && typeof inline !== "string") return null;
    if (domains !== undefined && !(Array.isArray(domains) && domains.every((d) => typeof d === "string"))) {
      return null;
    }
    out.push({
      ...(src !== undefined ? { src } : {}),
      ...(inline !== undefined ? { inline } : {}),
      ...(domains !== undefined ? { domains: domains as string[] } : {}),
    });
  }
  return out;
}

export async function approvedScriptHosts(d1: D1Database): Promise<string[]> {
  const { results } = await d1.prepare(SQL).all<Row>();
  const hosts: string[] = [];
  for (const row of results ?? []) {
    const scripts = asScripts(row.scripts);
    const approval = parseScriptsApproval(row.approval);
    if (!scripts || !approval) continue;
    if ((await hashScripts(scripts)) !== approval.hash) continue;
    for (const host of scriptHosts(scripts)) {
      // src 主機可能帶連接埠(scriptHosts 用 URL.host),domains 則只能是網域。
      const bare = host.replace(/:\d{1,5}$/, "");
      if (DOMAIN_RE.test(bare) && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

// ---- isolate 級 memo ----
//
// middleware 每個公開頁請求都要這份清單。每次都重讀 manifest、每個核准過的插件算一次
// SHA-256 是白做工 —— 清單只在安裝、核准、啟停時變。做法同 ext/loader 的 runtime memo:
// 每個請求對 declarative_extensions 算一次版本戳(COUNT、MAX(updated_at)、SUM(enabled)
// 三個聚合,一趟很輕的查詢),戳沒變就用上次的結果。安裝、更新、核准 / 撤銷 script、
// 啟停都會推進 updated_at 或改變列數 / 啟用數,所以任何一個寫入在下一個請求就看得見,
// 跨 isolate 也一樣。
//
// 不用 TTL:剛核准的外部 script 不帶 nonce、全靠主機白名單放行,TTL 期間它會在某些
// isolate 上被擋,管理員核准完馬上去看前台,看到的就是壞的。
//
// 戳在讀清單之前算:兩次讀之間若有寫入,存下來的是「較新的清單 + 較舊的戳」,下一個
// 請求的戳對不上、重讀一次而已,不會拿舊清單配新戳。middleware 與 route 是不同的
// bundle,module 狀態不共用,所以這裡沒有「寫入後主動清掉」的出口 —— 也不需要。
//
// 綁了 CMS_KV 的站,戳先從 KV 的副本拿(./stamps.ts):核准、撤銷、啟停 script 的寫入路徑
// 都會發布新戳,所以同樣是「寫入後就換戳」,只是其他機房要等 KV 快取過期(約 60 秒)。
// 副本拿到的戳可能比 D1 舊一點,但清單永遠是當下從 D1 讀的,「較新的清單 + 較舊的戳」
// 的方向不變。

let memo: { stamp: string; hosts: readonly string[] } | null = null;

async function combinedFromD1(d1: D1Database): Promise<StampsRecord | null> {
  try {
    return await readStampsRecordFromD1(d1);
  } catch {
    // 合併查詢要三張表都在;缺一張(只建了 declarative_extensions 的庫)就退回單表那條。
    return null;
  }
}

/** 白名單的版本戳。有夠新的 KV 副本就用它(零 D1),否則照舊問 D1。 */
async function scriptsStamp(d1: D1Database, kv: KvTarget | undefined): Promise<string> {
  if (kv) {
    const cached = await readStampsFromKv(kv.kv);
    if (cached.state === "fresh") return cached.stamps.scripts;
    if (cached.state === "refresh") {
      // 副本沒有、壞了、太舊:用合併查詢算(同樣一趟),順手把三組戳一起寫回 KV。
      const record = await combinedFromD1(d1);
      if (record) {
        refreshStamps(kv, record);
        return record.scripts;
      }
    }
  }
  const row = await d1.prepare(SCRIPTS_STAMP_SQL).first<ScriptsStampRow>();
  return scriptsStampFromRow(row);
}

/**
 * approvedScriptHosts 加上版本戳 memo(middleware 用)。kv 只在綁了 CMS_KV 的公開頁請求
 * 傳進來;沒傳就與以前一字不差。讀不到會丟例外,由呼叫端處理。
 */
export async function cachedApprovedScriptHosts(
  d1: D1Database,
  kv?: KvTarget,
): Promise<readonly string[]> {
  const stamp = await scriptsStamp(d1, kv);
  if (memo && memo.stamp === stamp) return memo.hosts;
  const hosts = Object.freeze(await approvedScriptHosts(d1));
  memo = { stamp, hosts };
  return hosts;
}
