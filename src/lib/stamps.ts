// [core] 三份 isolate memo 的版本戳:怎麼算、長什麼樣,以及選用的 Workers KV 副本。
//
// 誰在比對哪一組:
//   - settings.ts 的 readAll          → settings   `n:m`
//   - ext/loader.ts 的 getExtRuntime  → extensions `exN:exM:exE|dxN:dxM:dxE`
//   - public-csp.ts(middleware)     → scripts    `dxN:dxM:dxE`(= extensions 的後半)
// memo 比對的是字串:D1 算的、合併查詢算的、KV 讀回來的,只要格式差一個字,每次換條路
// 都會被當成「有變動」而重讀。所以 SQL 與格式化只寫在這裡,別處一律呼叫。
//
// 這個檔零依賴(只用 Workers 的全域型別):middleware 是 edge bundle,也要能載入。
//
// ---- KV 副本(binding CMS_KV,選用)----
//
// 沒有 KV 時,公開頁每個請求要打兩趟 D1 只為了問「設定變了沒」:middleware 一趟 scripts
// 戳、頁面一趟合併戳。離 D1 遠的機房一趟上百毫秒,而且答案幾乎總是「沒變」。KV 讀在機房
// 本地,所以公開頁改從 KV 拿戳:戳對得上 memo 的暖 isolate,一趟 D1 都不用打。
//
// 這仍然不是 TTL 快取 —— 新鮮度靠「寫入的人主動發布」:
//   - 寫入路徑本來就會呼叫 invalidateSettingsCache / invalidateExtRuntimeMemo,它們現在
//     同時發布:從 D1 一趟重算三組戳、寫進 KV(publishStamps)。KV 的寫入在寫入的那個
//     機房立即可見,其他機房在各自的 KV 快取過期後看見(約 60 秒)。所以管理員那一區,
//     存檔後下一個請求就是新的;其他地區約一分鐘內。
//   - 沒經過 invalidate 的寫入(seed script、手動下 SQL、發布本身失敗)由 at 兜底:副本
//     超過 STAMPS_MAX_AGE_MS 就不用,退回 D1 並補寫一份(refreshStamps)—— 最久 5 分鐘。
//   - 後台與 /api 一律照舊讀 D1(改東西的人要讀到自己剛寫的)。只有 middleware 認證過的
//     公開頁 GET 會用 KV(PUBLIC_PAGE_HEADER,見 middleware.ts、request-stamps.ts)。
//
// 沒綁 CMS_KV 的站:這個檔的 KV 部分一行都不會跑,行為與以前一字不差。
//
// 費用:公開頁每個請求 1–2 次 KV 讀;寫入 = 每次存檔一次 + 每個有流量的機房每 5 分鐘約一次。
// Workers 免費方案的 KV 額度(每天 10 萬讀、1 千寫)對有流量的站不夠 —— 付費方案再綁。

// ---- D1 ----

export const SETTINGS_STAMP_SQL =
  "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m FROM settings";

/** extension runtime 戳:extensions 與 declarative_extensions 各一組 (COUNT, MAX(updated_at), SUM(enabled))。 */
export const EXT_RUNTIME_STAMP_SQL = `SELECT
  (SELECT COUNT(*) FROM extensions) AS exN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM extensions) AS exM,
  (SELECT COALESCE(SUM(enabled), 0) FROM extensions) AS exE,
  (SELECT COUNT(*) FROM declarative_extensions) AS dxN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM declarative_extensions) AS dxM,
  (SELECT COALESCE(SUM(enabled), 0) FROM declarative_extensions) AS dxE`;

/** CSP 主機白名單的戳:只看 declarative_extensions(middleware 只讀這張表)。 */
export const SCRIPTS_STAMP_SQL = `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(SUM(enabled), 0) AS e
  FROM declarative_extensions`;

/** 三組戳一趟拿齊(scalar subselect)。任一張表不存在就整條失敗,呼叫端各自退回。 */
export const COMBINED_STAMP_SQL = `SELECT
  (SELECT COUNT(*) FROM settings) AS sN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM settings) AS sM,
  (SELECT COUNT(*) FROM extensions) AS exN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM extensions) AS exM,
  (SELECT COALESCE(SUM(enabled), 0) FROM extensions) AS exE,
  (SELECT COUNT(*) FROM declarative_extensions) AS dxN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM declarative_extensions) AS dxM,
  (SELECT COALESCE(SUM(enabled), 0) FROM declarative_extensions) AS dxE`;

export interface SettingsStampRow {
  n: number;
  m: number;
}

export interface ScriptsStampRow {
  n: number;
  m: number;
  e: number;
}

export interface ExtRuntimeStampRow {
  exN: number;
  exM: number;
  exE: number;
  dxN: number;
  dxM: number;
  dxE: number;
}

export interface CombinedStampRow extends ExtRuntimeStampRow {
  sN: number;
  sM: number;
}

// 查不到列(聚合查詢理論上不會)一律當空表:與既有三條路的行為相同。
export function settingsStampFromRow(row: SettingsStampRow | null): string {
  return `${row?.n ?? 0}:${row?.m ?? 0}`;
}

export function scriptsStampFromRow(row: ScriptsStampRow | null): string {
  return `${row?.n ?? 0}:${row?.m ?? 0}:${row?.e ?? 0}`;
}

export function extRuntimeStampFromRow(row: ExtRuntimeStampRow | null): string {
  const code = `${row?.exN ?? 0}:${row?.exM ?? 0}:${row?.exE ?? 0}`;
  const scripts = scriptsStampFromRow(row && { n: row.dxN, m: row.dxM, e: row.dxE });
  return `${code}|${scripts}`;
}

export interface StampSet {
  settings: string;
  extensions: string;
  scripts: string;
}

/** 一組戳加上「什麼時候從 D1 算的」—— KV 裡存的就是這個。 */
export interface StampsRecord extends StampSet {
  at: number;
}

export function stampsFromCombinedRow(row: CombinedStampRow | null): StampSet {
  return {
    settings: settingsStampFromRow(row && { n: row.sN, m: row.sM }),
    extensions: extRuntimeStampFromRow(row),
    scripts: scriptsStampFromRow(row && { n: row.dxN, m: row.dxM, e: row.dxE }),
  };
}

/**
 * 從 D1 一趟算出三組戳。at 取查詢**之前**的時間:寧可讓副本早一點過期,也不要讓它看起來
 * 比實際新。失敗會 throw。
 */
export async function readStampsRecordFromD1(d1: D1Database): Promise<StampsRecord> {
  const at = Date.now();
  const row = await d1.prepare(COMBINED_STAMP_SQL).first<CombinedStampRow>();
  return { ...stampsFromCombinedRow(row), at };
}

// ---- KV ----

export const STAMPS_KV_KEY = "cms:request-stamps:v1";

/** 副本最多用多久。只兜「漏發」的底;正常的寫入靠發布,不等它過期。 */
export const STAMPS_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * middleware 蓋在公開頁 GET 請求上的內部標頭:「這一頁可以用 KV 的戳」。瀏覽器自己帶來的
 * 一律刪掉 —— middleware 經過的路徑由 middleware 刪,它不經過的(/api、/_next)由
 * custom-worker.ts 刪(stripPublicPageHeader)。
 */
export const PUBLIC_PAGE_HEADER = "x-cms-public-page";
export const PUBLIC_PAGE_VALUE = "1";

/** 寫 KV 需要的東西:binding 與這個請求的 waitUntil(發布一律在回應之後做)。 */
export interface KvTarget {
  kv: KVNamespace;
  waitUntil(promise: Promise<unknown>): void;
}

export interface StampsTarget extends KvTarget {
  d1: D1Database;
}

/**
 * CMS_KV 是選用 binding,不在各站產生的 CloudflareEnv 型別裡 —— 同 cf.ts 讀 AI 的
 * unknown cast。沒綁(或綁錯成別的東西)、或拿不到 waitUntil → undefined,呼叫端照舊走 D1。
 */
export function kvTargetFrom(env: unknown, ctx: unknown): KvTarget | undefined {
  const kv = (env as { CMS_KV?: unknown } | null | undefined)?.CMS_KV as KVNamespace | undefined;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return undefined;
  const context = ctx as ExecutionContext | null | undefined;
  if (!context || typeof context.waitUntil !== "function") return undefined;
  return { kv, waitUntil: (promise) => context.waitUntil(promise) };
}

export type KvStamps =
  /** 副本在、格式對、還沒超過 STAMPS_MAX_AGE_MS:直接用。 */
  | { state: "fresh"; stamps: StampSet }
  /** 沒有、壞掉、或太舊:走 D1,並補寫一份。 */
  | { state: "refresh" }
  /** KV 本身讀不到:走 D1,不寫(寫大概也會失敗)。 */
  | { state: "unavailable" };

function parseStampsRecord(raw: string | null): StampsRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { settings, extensions, scripts, at } = value as Record<string, unknown>;
  if (typeof settings !== "string" || typeof extensions !== "string" || typeof scripts !== "string") {
    return null;
  }
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // extensions 的後半就是 scripts(同一組 declarative_extensions 聚合),對不上就不是我們寫的。
  if (!extensions.endsWith(`|${scripts}`)) return null;
  return { settings, extensions, scripts, at };
}

/** 讀 KV 副本。永不 throw(KV 錯誤記一筆、回 unavailable)。 */
export async function readStampsFromKv(kv: KVNamespace): Promise<KvStamps> {
  let raw: string | null;
  try {
    raw = await kv.get(STAMPS_KV_KEY);
  } catch (e) {
    console.error("[stamps] KV read failed; using D1", e);
    return { state: "unavailable" };
  }
  const record = parseStampsRecord(raw);
  // 雙向都看:時鐘不準寫出「未來」的 at,也不能讓它永遠不過期。
  if (!record || Math.abs(Date.now() - record.at) >= STAMPS_MAX_AGE_MS) return { state: "refresh" };
  const { settings, extensions, scripts } = record;
  return { state: "fresh", stamps: { settings, extensions, scripts } };
}

// ---- 寫 KV ----
//
// KV 同一個 key 一秒最多寫一次(超過回 429),所以兩條寫入路都要節制:
//   - 發布(寫入之後):一個 isolate 同時只跑一輪;跑的期間又有寫入 → 跑完隔一秒再發一次,
//     讀的是那時的 D1,所以最後留在 KV 的一定涵蓋最後一筆寫入。一次存檔常常連叫兩三次
//     invalidate(settings 與 runtime 各一),合併成一到兩次寫。寫不進去隔一秒重試一次
//     (重讀 D1);還是不行就刪掉副本,讓公開頁回去讀 D1 —— 不能讓一份早於這次寫入的副本
//     繼續被當成最新。
//   - 補寫(讀的一方發現副本過期):盡力而為,一個 isolate 每 10 秒最多一次,正在發布就不補。
//     過期是各機房同時發生的,不節制的話每個請求都會去撞那一秒一次的上限。

const KV_SAME_KEY_INTERVAL_MS = 1_000;
const REFRESH_INTERVAL_MS = 10_000;

let publishing = false;
let publishAgain = false;
let lastRefresh = Number.NEGATIVE_INFINITY;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function inBackground(target: KvTarget, task: Promise<unknown>): void {
  try {
    target.waitUntil(task);
  } catch (e) {
    console.error("[stamps] could not schedule a KV write", e);
  }
}

async function publishOnce({ d1, kv }: StampsTarget): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await kv.put(STAMPS_KV_KEY, JSON.stringify(await readStampsRecordFromD1(d1)));
      return;
    } catch (e) {
      if (attempt >= 2) {
        console.error("[stamps] could not publish request stamps to KV; dropping the copy", e);
        try {
          await kv.delete(STAMPS_KV_KEY);
        } catch (deleteError) {
          console.error("[stamps] could not drop the KV copy either", deleteError);
        }
        return;
      }
      await sleep(KV_SAME_KEY_INTERVAL_MS);
    }
  }
}

async function publishLoop(target: StampsTarget): Promise<void> {
  try {
    let lastPut = 0;
    do {
      publishAgain = false;
      if (lastPut > 0) await sleep(Math.max(0, lastPut + KV_SAME_KEY_INTERVAL_MS - Date.now()));
      await publishOnce(target);
      lastPut = Date.now();
    } while (publishAgain);
  } finally {
    // 與上面最後一次檢查 publishAgain 在同一段同步程式裡:中間沒有 await,不會漏接。
    publishing = false;
  }
}

/** 寫入之後:從 D1 重算三組戳寫進 KV(在 waitUntil 裡)。永不 throw。 */
export function publishStamps(target: StampsTarget): void {
  if (publishing) {
    publishAgain = true;
    return;
  }
  publishing = true;
  inBackground(
    target,
    publishLoop(target).catch((e: unknown) => console.error("[stamps] publish failed", e)),
  );
}

/** 讀的一方剛從 D1 算好一份(副本沒有 / 壞了 / 太舊):順手寫回 KV。節流,永不 throw。 */
export function refreshStamps(target: KvTarget, record: StampsRecord): void {
  const now = Date.now();
  if (publishing || now - lastRefresh < REFRESH_INTERVAL_MS) return;
  lastRefresh = now;
  inBackground(
    target,
    target.kv
      .put(STAMPS_KV_KEY, JSON.stringify(record))
      .catch((e: unknown) => console.error("[stamps] could not refresh the KV copy", e)),
  );
}

/**
 * Worker 入口(custom-worker.ts)對**每一個**請求呼叫:瀏覽器自己帶 PUBLIC_PAGE_HEADER
 * 就刪掉。middleware 的 matcher 不含 /api 與 /_next,那些路徑只有這裡守得住;沒帶的
 * 請求原樣傳下去,不多做任何事。
 */
export function stripPublicPageHeader(request: Request): Request {
  if (!request.headers.has(PUBLIC_PAGE_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(PUBLIC_PAGE_HEADER);
  return new Request(request, { headers });
}
