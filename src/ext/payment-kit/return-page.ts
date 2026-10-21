import { defineValueSlot, type SlotRegistry } from "../slots";
import { isSitePath } from "../site-path";

// 付款之後客人回到哪一頁(插槽的機制見 slots.ts;1.78.0)。
//
// 金流把客人送回來時 —— ReturnURL(付完、或付款沒有成功)與 ClientBackURL(還沒付就在付款頁按「返回商店」)
// —— kit 只知道訂單編號,不知道那是商店的訂單、經銷商買點數還是別的。認得這筆的插件報一個站內路徑:
//   fill(PaymentReturn, (pages) => [...pages, { path: async (orderNo, outcome) => (await mine(orderNo)) ? `/shop/orders?order=${orderNo}` : null }])
// 一定要 append。依序問,第一個回站內路徑的贏(isSitePath 擋掉站外網址);都不認得時照舊:付完、失敗是 kit 的
// 結果頁,返回商店是首頁。path 可以讀資料庫,每次客人回來問一次。
//
// outcome:paid 付款完成、failed 付款沒有成功、back 還沒付就從付款頁回來。

export type PaymentReturnOutcome = "paid" | "failed" | "back";

export interface PaymentReturnPage {
  /** 這筆是你的就回站內路徑(/ 開頭),不是就回 null。 */
  path: (orderNo: string, outcome: PaymentReturnOutcome) => string | null | Promise<string | null>;
}

export const PaymentReturn = defineValueSlot<PaymentReturnPage[]>("site.payment.return");

/** 一次最多問幾個(擋住填壞的)。 */
const MAX_PAGES = 20;

/** 認得這筆訂單的插件給的站內路徑;沒有人認得(或沒有插槽)是 null。出錯的那一個跳過、記下來。 */
export async function paymentReturnPath(
  slots: SlotRegistry | undefined,
  orderNo: string,
  outcome: PaymentReturnOutcome,
): Promise<string | null> {
  if (!slots || !orderNo) return null;
  const pages: unknown = slots.value(PaymentReturn, []);
  if (!Array.isArray(pages)) return null;
  for (const page of pages.slice(0, MAX_PAGES)) {
    try {
      const path = typeof page?.path === "function" ? await page.path(orderNo, outcome) : null;
      if (isSitePath(path)) return path;
    } catch (error) {
      console.error("[payment-kit] a PaymentReturn page failed", error);
    }
  }
  return null;
}
