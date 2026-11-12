// [core] 2.0 頁面快取:哪些插件表的資料會畫在公開頁上(Extension.publicTables)。
//
// 插件宣告 `publicTables: ["ext_inventory_accounts"]`,loader 依啟用的插件把這些表交給 setPublicTables
// (同 jobs[].wakeOn → setWakeTables,src/lib/wake.ts)。ledger-kit 的交易成立之後問 publicTablesIn:
// 這次寫到的表裡有宣告過的,就通知 publicContentChanged —— 庫存扣了、補了、退了,存起來的公開頁跟著重算,
// 插件自己不用寫一行。不經 ledger-kit 的寫入由插件自己呼叫 services.publicContentChanged。
//
// 這個檔沒有任何相依:ledger-kit 用相對路徑 import 它。

const publicTables = new Set<string>();

/** loader 每次建 runtime 時呼叫:啟用中的插件宣告的 publicTables。 */
export function setPublicTables(tables: Iterable<string>): void {
  publicTables.clear();
  for (const table of tables) publicTables.add(table);
}

/** 這些表裡有哪幾張被宣告為公開(去重,保持順序)。 */
export function publicTablesIn(tables: Iterable<string>): string[] {
  const out: string[] = [];
  for (const table of tables) {
    if (publicTables.has(table) && !out.includes(table)) out.push(table);
  }
  return out;
}
