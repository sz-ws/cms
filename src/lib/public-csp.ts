import { APPROVED_SCRIPTS_SQL, approvedScriptHosts, hostsFromApprovedRows, type ApprovedScriptsRow } from "./script-hosts";
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

export { approvedScriptHosts };

// [core] 公開頁 CSP 的主機白名單(middleware 用):啟用中、而且核准紀錄對得上目前內容的
// 宣告式插件 scripts,它們的 src 主機與宣告的 domains。清單怎麼算在 ./script-hosts.ts
// (與 KV 副本、冷啟動的合併讀取共用);這個檔只管「什麼時候重算」。
//
// 在 middleware(edge)裡跑,所以只用 D1 binding 與零依賴的模組 —— 不拉 drizzle、zod、loader。
//
// 1.51.0:插件的前台編進了網站(public:scripts)時,它的 scripts 不會輸出,主機也不該
// 在白名單上。middleware 是另一個 bundle,看不到編進來的程式碼 —— 靠的是「被取代的
// script 沒有核准紀錄」:安裝時清掉、不能再核准、編進去之前的由 loader 清掉
// (ext/dx/scripts-compiled.ts)。所以這裡照舊只看核准。編進來的元件是 bundle 裡的
// 程式,'self' 就涵蓋,不用放行任何主機。

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
// 副本拿到的戳可能比 D1 舊一點;副本帶的清單與它的戳是同一個 D1 batch 讀的,兩者一定
// 對得上(不是「舊戳配新清單」,是同一個時間點的一對)。副本沒帶清單時照舊當下從 D1 讀,
// 「較新的清單 + 較舊的戳」的方向不變。
//
// 冷的 isolate(memo 是空的)不再「先問戳、再讀清單」兩趟:有 KV 就用副本裡的清單,沒有
// 就把戳與清單放進同一個 batch。

let memo: { stamp: string; hosts: readonly string[] } | null = null;

async function combinedFromD1(d1: D1Database): Promise<StampsRecord | null> {
  try {
    return await readStampsRecordFromD1(d1);
  } catch {
    // 合併查詢要三張表都在;缺一張(只建了 declarative_extensions 的庫)就退回單表那條。
    return null;
  }
}

/** 白名單的版本戳,以及(拿得到的話)與它同一個 D1 狀態的清單。 */
interface StampedHosts {
  stamp: string;
  /** undefined = 只拿到戳,清單要看 memo 或另外問 D1。 */
  hosts?: readonly string[];
}

/**
 * 有夠新的 KV 副本就用它(零 D1);副本帶了清單,冷的 isolate 也不必再問。副本沒有 /
 * 壞了 / 太舊:一個 batch 算三組戳加清單,順手寫回 KV。沒有 KV 時照舊問 D1 的戳。
 */
async function stampedFromKv(d1: D1Database, kv: KvTarget): Promise<StampedHosts | null> {
  const cached = await readStampsFromKv(kv.kv);
  if (cached.state === "fresh") return { stamp: cached.stamps.scripts, hosts: cached.hosts };
  if (cached.state === "refresh") {
    const record = await combinedFromD1(d1);
    if (record) {
      refreshStamps(kv, record);
      return { stamp: record.scripts, hosts: record.hosts };
    }
  }
  return null;
}

/**
 * 只有 D1 的那條路。memo 是空的(冷的 isolate)時,戳與清單在同一個 batch 裡一起讀:
 * 一趟就好,而且兩者一定對得上。memo 在的時候只問戳 —— 絕大多數請求的答案是「沒變」。
 */
async function stampedFromD1(d1: D1Database): Promise<StampedHosts> {
  if (memo) {
    const row = await d1.prepare(SCRIPTS_STAMP_SQL).first<ScriptsStampRow>();
    return { stamp: scriptsStampFromRow(row) };
  }
  const [stamp, approved] = await d1.batch<unknown>([
    d1.prepare(SCRIPTS_STAMP_SQL),
    d1.prepare(APPROVED_SCRIPTS_SQL),
  ]);
  return {
    stamp: scriptsStampFromRow((stamp.results?.[0] ?? null) as ScriptsStampRow | null),
    hosts: await hostsFromApprovedRows((approved.results ?? []) as ApprovedScriptsRow[]),
  };
}

/**
 * approvedScriptHosts 加上版本戳 memo(middleware 用)。kv 只在綁了 CMS_KV 的公開頁請求
 * 傳進來。讀不到會丟例外,由呼叫端處理。
 */
export async function cachedApprovedScriptHosts(
  d1: D1Database,
  kv?: KvTarget,
): Promise<readonly string[]> {
  const stamped = (kv ? await stampedFromKv(d1, kv) : null) ?? (await stampedFromD1(d1));
  if (memo && memo.stamp === stamped.stamp) return memo.hosts;
  const hosts = Object.freeze(stamped.hosts ? [...stamped.hosts] : await approvedScriptHosts(d1));
  memo = { stamp: stamped.stamp, hosts };
  return hosts;
}
