// [core] 兩份 isolate memo 的版本戳:怎麼算、長什麼樣。
//
// 誰在比對哪一組:
//   - settings.ts 的 readAll          → settings   `n:m`
//   - ext/loader.ts 的 getExtRuntime  → extensions `exN:exM:exE|dxN:dxM:dxE`
// memo 比對的是字串:D1 單獨算的、合併查詢算的、冷啟動的合併讀取算的,只要格式差一個字,每次
// 換條路都會被當成「有變動」而重讀。所以 SQL 與格式化只寫在這裡,別處一律呼叫。
//
// 這個檔零依賴(只用 Workers 的全域型別)。

// ---- D1 ----

export const SETTINGS_STAMP_SQL =
  "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m FROM settings";

// D1 依「掃過的列」計費,而這幾條查詢每個請求都跑。一張表的幾個數字放在同一個子查詢裡
// 一次算完(一張表掃一次);每個數字各寫一條 scalar subselect 的話,同一張表會被掃兩三次。
// 沒有 GROUP BY 的聚合一定回一列,所以空表照樣得到 0,三個子查詢相乘也還是一列。
const EXTENSIONS_AGGREGATE =
  "(SELECT COUNT(*) AS exN, COALESCE(MAX(updated_at), 0) AS exM, COALESCE(SUM(enabled), 0) AS exE FROM extensions) AS ex";
const DECLARATIVE_AGGREGATE =
  "(SELECT COUNT(*) AS dxN, COALESCE(MAX(updated_at), 0) AS dxM, COALESCE(SUM(enabled), 0) AS dxE FROM declarative_extensions) AS dx";

/** extension runtime 戳:extensions 與 declarative_extensions 各一組 (COUNT, MAX(updated_at), SUM(enabled))。 */
export const EXT_RUNTIME_STAMP_SQL = `SELECT ex.exN, ex.exM, ex.exE, dx.dxN, dx.dxM, dx.dxE
  FROM ${EXTENSIONS_AGGREGATE}, ${DECLARATIVE_AGGREGATE}`;

/** 兩組戳一趟拿齊,每張表掃一次。任一張表不存在就整條失敗,呼叫端各自退回。 */
export const COMBINED_STAMP_SQL = `SELECT s.sN, s.sM, ex.exN, ex.exM, ex.exE, dx.dxN, dx.dxM, dx.dxE
  FROM (SELECT COUNT(*) AS sN, COALESCE(MAX(updated_at), 0) AS sM FROM settings) AS s,
    ${EXTENSIONS_AGGREGATE}, ${DECLARATIVE_AGGREGATE}`;

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
}

export function stampsFromCombinedRow(row: CombinedStampRow | null): StampSet {
  return {
    settings: settingsStampFromRow(row && { n: row.sN, m: row.sM }),
    extensions: extRuntimeStampFromRow(row),
  };
}
