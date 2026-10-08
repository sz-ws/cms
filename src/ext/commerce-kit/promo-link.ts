import { forgetCheckoutValue, readCheckoutValue, rememberCheckoutValue } from "./checkout-prefill";
import { normalizePromoCode, PROMO_CODE_RE } from "./promo-code";

// commerce-kit:優惠碼的分享連結。
//
// 任何公開頁的網址帶 ?promo=代碼,有優惠碼的那個商店插件把它記在瀏覽器裡(checkout-prefill,30 天),
// 結帳頁先帶入並套用,客人不用自己打。記下的只是「先帶入」:能不能用,結帳時伺服器照樣檢查。
//
// 沒有 React、不碰伺服器。兩邊共用這個檔:組連結的一方(例如把優惠碼發給合作對象的插件)用 promoLink,
// 記連結與結帳頁用其餘的。

/** 網址上的參數名稱。 */
export const PROMO_LINK_PARAM = "promo";
/** 記在 checkout-prefill 的名字。沒有點,不會和結帳欄位(`<providerId>.<key>`)撞名。 */
export const PROMO_PREFILL_NAME = "promo";
/** 連結帶來的優惠碼記幾天。 */
export const PROMO_LINK_DAYS = 30;

/**
 * 帶著優惠碼的連結。path:站內路徑(預設首頁,記連結的元件在每一個公開頁都在);origin:完整網址的開頭
 * (例如站台網址),沒給只回路徑。
 */
export function promoLink(code: string, options: { origin?: string; path?: string } = {}): string {
  const path = options.path ?? "/";
  const joiner = path.includes("?") ? "&" : "?";
  const origin = (options.origin ?? "").replace(/\/+$/, "");
  return `${origin}${path}${joiner}${PROMO_LINK_PARAM}=${encodeURIComponent(normalizePromoCode(code))}`;
}

/** 網址上的優惠碼(轉成儲存形);沒有、或不可能是優惠碼的字是 ""。 */
export function promoCodeFromUrl(href: string): string {
  let raw: string | null;
  try {
    raw = new URL(href).searchParams.get(PROMO_LINK_PARAM);
  } catch {
    return "";
  }
  const code = normalizePromoCode(raw ?? "");
  return PROMO_CODE_RE.test(code) ? code : "";
}

/** 把網址上的優惠碼記下來(取代先前記的);回傳網址上的代碼,沒有是 ""。瀏覽器不讓存時什麼都不做。 */
export function rememberPromoLink(href: string, now: number = Date.now()): string {
  const code = promoCodeFromUrl(href);
  if (code) rememberCheckoutValue(PROMO_PREFILL_NAME, code, { days: PROMO_LINK_DAYS, now });
  return code;
}

/** 記下的優惠碼;沒有、過期、或存的不是代碼是 ""。 */
export function rememberedPromoCode(now: number = Date.now()): string {
  const code = readCheckoutValue(PROMO_PREFILL_NAME, now);
  return PROMO_CODE_RE.test(code) ? code : "";
}

/** 忘掉記下的優惠碼;給了 code 時只有記下的就是它才忘。 */
export function forgetPromoLink(code?: string, now: number = Date.now()): void {
  forgetCheckoutValue(PROMO_PREFILL_NAME, code, now);
}
