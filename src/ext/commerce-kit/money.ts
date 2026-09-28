import { DEFAULT_CURRENCY, formatUnit } from "@/lib/units";

// 商店金額的寫法,server 與 client 都能 import。1.61.0 從 returns-ui.ts 抽出來。
// 1.63.0:照站台幣別寫(core.currency;寫法在 lib/units.ts):NT$ 1,200、$ 1,200、¥ 1,200。
// 呼叫端傳幣別 —— server 用 getSiteCurrency()(lib/units-server.ts),client 用 useSiteCurrency()
// (components/CurrencyProvider.tsx)。
//
// 限制:金額一律是整數的「元」(幣別的整數單位),沒有分;改 core.currency 只換寫法,過去的訂單
// 跟著換標示,不換算。要支援小數位的幣別是 2.x 的事,不是加一個設定。

/** 一個金額,照幣別寫。currency 省略 = DEFAULT_CURRENCY(1.61.0 的呼叫端)。 */
export function formatMoney(amount: number, currency: string = DEFAULT_CURRENCY): string {
  return formatUnit(amount, { kind: "currency" }, "zh-Hant", currency);
}
