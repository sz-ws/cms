import { declareVisitorFacing, wrote } from "../../lib/visitor-facing";

// 2.0 頁面快取:commerce-kit 定義的表(訂單、優惠碼)畫在公開頁上 —— 「最近成交」feed、賣出的件數、
// 結帳頁的優惠碼欄。定義者宣告:這些表預設帶著 visitorFacing 記號(src/lib/visitor-facing.ts),
// 用 kit 的插件在 Extension.visitorFacingTables 寫 `{ <表名>: false }` 退出。

/** kit 寫完一張自己定義的表之後呼叫:登記預設記號,交給 visitorFacing 的規則。永不 throw。 */
export function kitTableWritten(table: string): void {
  declareVisitorFacing(`commerce-kit:${table}`, "table", [[table, true]], { fallback: true });
  wrote("table", table);
}
