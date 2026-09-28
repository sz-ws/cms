// 商店金額的寫法:NT$ 1,200(基礎商店的價格都是新台幣元)。server 與 client 都能 import。
// 1.61.0 從 returns-ui.ts 抽出來,儀表板的營業額卡與插件的報表用同一個寫法。

export function formatMoney(amount: number): string {
  return `NT$ ${amount.toLocaleString("zh-TW")}`;
}
