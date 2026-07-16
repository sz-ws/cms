import { getDB } from "@/lib/cf";

// 版本戳(version stamp):用「一次 SQL round trip」為 extensions 與
// declarative_extensions 兩張表算出決定性指紋。loader 的 module 級 memo 靠它判斷
// 快取是否仍新鮮 —— 每個 request 都重算此戳並比對,故跨 isolate 的更新也保證看得見
// (不是 TTL,是每次都對 DB 現況重新指紋)。
//
// 指紋公式:兩表皆有 updated_at + enabled,故各取 (COUNT, MAX(updated_at),
// SUM(enabled)) 三元組。所有會改動這兩表的路徑(manager.ts 的 enable/disable/
// uninstall、install route 的 upsert)都會 bump updated_at 或改變 row 數,因此
// 任一 mutation 都必然改變此戳。
//
// 用 getDB() 直打 D1(而非 drizzle db()):這只是低階純量指紋查詢,scalar subselect
// 一趟到底最省;失敗由 loader 端 catch 後退回完整載入路徑(§5:絕不 crash loader)。

interface StampRow {
  exN: number;
  exM: number;
  exE: number;
  dxN: number;
  dxM: number;
  dxE: number;
}

const STAMP_SQL = `SELECT
  (SELECT COUNT(*) FROM extensions) AS exN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM extensions) AS exM,
  (SELECT COALESCE(SUM(enabled), 0) FROM extensions) AS exE,
  (SELECT COUNT(*) FROM declarative_extensions) AS dxN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM declarative_extensions) AS dxM,
  (SELECT COALESCE(SUM(enabled), 0) FROM declarative_extensions) AS dxE`;

/**
 * 計算目前的 extension runtime 版本戳。失敗時 throw(呼叫端負責 fallback)。
 */
export async function computeExtRuntimeStamp(): Promise<string> {
  const row = await getDB().prepare(STAMP_SQL).first<StampRow>();
  if (!row) return "0:0:0|0:0:0";
  return `${row.exN}:${row.exM}:${row.exE}|${row.dxN}:${row.dxM}:${row.dxE}`;
}
