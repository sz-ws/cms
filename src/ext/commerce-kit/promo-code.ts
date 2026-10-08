// commerce-kit:優惠碼代碼的格式。沒有相依:伺服器(promo.ts)與瀏覽器(promo-link.ts、結帳頁)共用同一條規則。

/** 客人輸入 → 儲存形:去空白、大寫。空字串 = 沒有碼。 */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** 儲存形的格式:大寫英文、數字、- 與 _,2 到 40 個字,開頭是英文或數字。 */
export const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
