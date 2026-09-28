import type { OrderStorefront } from "./order-manager";

/**
 * @deprecated 1.63.0 — remove in 2.0.
 *
 * 1.63.0 以前,訂單管理插件只用 guestCheckout() 告訴商店開不開放訪客結帳(沒有這個函式 = 要登入),
 * 電話與地址一律必填。還沒實作 storefront() 的插件照這個規則畫;它沒說訂單頁在哪,所以沒有訂單頁的連結。
 */
export async function legacyStorefront(manager: unknown): Promise<OrderStorefront> {
  const guestCheckout = (manager as { guestCheckout?: () => Promise<unknown> } | null)?.guestCheckout;
  const guest = typeof guestCheckout === "function" && (await guestCheckout.call(manager)) === true;
  return { signIn: guest ? "optional" : "required", requireContact: true, ordersHref: null };
}
