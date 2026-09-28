import type { MetricDecl } from "../dashboard-widgets";

// 1.62.0:商務的共用數字(Extension.metrics)。儀表板上宣告同一個 metric 的 widget 合成一張卡,所以
// 收錢的插件(例如一個訂單插件、一個儲值插件)各自宣告 REVENUE、各自交一條每日金額的線,就疊在同一張圖上。
// 每個插件都要自己宣告(`metrics: [REVENUE]`):這樣只啟用其中一個插件時,它的線照樣畫得出來。
// 宣告的內容一模一樣,不會互相衝突;凍結起來,免得哪個插件改了它,讓大家的宣告對不上。

/** 營業額:每天收到的金額,單位是站台幣別(core.currency),各插件的金額加總。 */
export const REVENUE: Readonly<MetricDecl> = Object.freeze({
  key: "commerce.revenue",
  label: Object.freeze({ "zh-Hant": "營業額", en: "Revenue" }),
  unit: Object.freeze({ kind: "currency" as const }),
  combine: "sum" as const,
});
