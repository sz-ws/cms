import {
  DOMAIN_RE,
  hashScripts,
  parseScriptsApproval,
  scriptHosts,
  type ScriptSourceLike,
} from "@/ext/dx/scripts-core";

// [core] 公開頁 CSP 的主機白名單:啟用中、而且核准紀錄對得上目前內容的宣告式插件
// scripts,它們的 src 主機與宣告的 domains。判斷與 ext/dx/scripts-widget.tsx 同一條
// (hash 對不上就不渲染 = 也不放行)。
//
// 在 middleware(edge)裡跑,所以只用 D1 binding 與零依賴的 scripts-core —— 不拉
// drizzle、zod、loader。manifest 裡的 scripts 安裝時已經過 zod;這裡只做「形狀對、
// 值合規」的最小檢查,因為結果會寫進回應標頭。

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

const STAMP_SQL = `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(SUM(enabled), 0) AS e
  FROM declarative_extensions`;

let memo: { stamp: string; hosts: readonly string[] } | null = null;

/** approvedScriptHosts 加上版本戳 memo(middleware 用)。讀不到會丟例外,由呼叫端處理。 */
export async function cachedApprovedScriptHosts(d1: D1Database): Promise<readonly string[]> {
  const row = await d1.prepare(STAMP_SQL).first<{ n: number; m: number; e: number }>();
  const stamp = `${row?.n ?? 0}:${row?.m ?? 0}:${row?.e ?? 0}`;
  if (memo && memo.stamp === stamp) return memo.hosts;
  const hosts = Object.freeze(await approvedScriptHosts(d1));
  memo = { stamp, hosts };
  return hosts;
}
