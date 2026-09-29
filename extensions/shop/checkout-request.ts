import type { CartItem } from "./cart-store";

// 結帳頁送出的內容與伺服器錯誤的說法(0.9.0 從 CheckoutView 拆出來;沒有 React,測試直接呼叫)。
//
// 不管結帳由商店自己處理還是交給訂單管理插件,body 都是同一種:requestId(重送不重複建單)、
// 商品、聯絡資料、配送、優惠碼、付款方式,以及插件宣告的結帳欄位(fields,commerce-kit checkout-fields)。
// 回覆是 { ok: true, orderNo, session, expiresAt? }:expiresAt(0.11.0)是付款期限,只有訂單管理插件會帶。

export const CHECKOUT_URL = "/api/ext/shop/checkout";

const ERROR_HINT: Record<string, string> = {
  invalid_input: "資料不完整或格式不對，請檢查後再送出。",
  unknown_product: "購物車內有商品已下架，請回購物車移除後重試。",
  unpriced_product: "購物車內有商品目前無法結帳，請回購物車移除後重試。",
  invalid_total: "訂單金額不正確。",
  invalid_shipping: "請選擇配送方式。",
  promo_invalid: "優惠碼無法使用，請移除後重試。",
  method_not_enabled: "此付款方式目前未開放。",
  not_available: "付款服務暫時無法使用，請稍後再試。",
  not_configured: "付款方式尚未設定完成，請聯絡店家。",
  rate_limited: "嘗試次數過多，請稍後再試。",
  unauthorized: "請先登入會員再結帳。",
  checkout_paused: "目前暫停結帳，請稍後再試。",
};

export const PROMO_REASON: Record<string, string> = {
  not_found: "查無此優惠碼。",
  disabled: "此優惠碼已停用。",
  not_started: "此優惠碼尚未開始。",
  expired: "此優惠碼已過期。",
  exhausted: "此優惠碼已被用完。",
  below_min_subtotal: "未達此優惠碼的低消門檻。",
};

/** 伺服器的錯誤代碼 → 一句話;不認得的(例如接手訂單的插件回的一句話)接在「結帳失敗：」後面。 */
export function explainCheckoutError(code: string): string {
  return ERROR_HINT[code] ?? `結帳失敗：${code}`;
}

/** 這個錯誤要客人先登入(說法旁邊放「登入」連結)。 */
export function needsSignIn(code: string): boolean {
  return code === "unauthorized";
}

/**
 * 結帳回覆的付款期限(0.11.0,`expiresAt`,epoch ms)。有期限的一方才帶(訂單管理插件);沒帶、
 * 或不是合理的時間,當作不知道 —— 結局頁照舊不寫期限。
 */
export function paymentDeadline(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 優惠碼試算失敗的說法。 */
export function explainPromoError(error: string, reason?: string): string {
  return (reason && PROMO_REASON[reason]) ?? ERROR_HINT[error] ?? "優惠碼無法使用。";
}

export interface CheckoutDraft {
  items: readonly CartItem[];
  name: string;
  email: string;
  phone: string;
  address: string;
  region: string;
  /** 選到的配送方式;沒有選項時是 ""(店家還沒設運費時,接手訂單的插件回一句話,不是格式錯誤)。 */
  shippingMethodId: string;
  promoCode?: string;
  method: "card" | "transfer";
  /** 結帳欄位的值(`<providerId>.<key>` → 值)。 */
  fields: Readonly<Record<string, string>>;
}

/** 要送出的 body。空白的選填欄位不送。 */
export function checkoutBody(draft: CheckoutDraft, requestId: string): Record<string, unknown> {
  const trimmed = (value: string) => value.trim();
  const fields = Object.fromEntries(
    Object.entries(draft.fields)
      .map(([name, value]) => [name, trimmed(value)] as const)
      .filter(([, value]) => value !== ""),
  );
  return {
    requestId,
    items: draft.items.map((item) => ({ productId: item.productId, qty: item.qty })),
    name: trimmed(draft.name),
    email: trimmed(draft.email),
    ...(trimmed(draft.phone) ? { phone: trimmed(draft.phone) } : {}),
    ...(trimmed(draft.address) ? { address: trimmed(draft.address) } : {}),
    ...(draft.region ? { region: draft.region } : {}),
    shippingMethodId: draft.shippingMethodId,
    ...(draft.promoCode ? { promoCode: draft.promoCode } : {}),
    method: draft.method,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/**
 * 同一份內容重送沿用同一個 requestId(伺服器認得是同一筆,不重複建單);內容改了換一個新的。
 * previous 是上一次送出的指紋與編號。
 */
export function requestFor(
  previous: { fingerprint: string; id: string } | null,
  draft: CheckoutDraft,
  newId: () => string,
): { fingerprint: string; id: string } {
  const fingerprint = JSON.stringify(checkoutBody(draft, ""));
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, id: newId() };
}
