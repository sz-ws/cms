import type { CommerceDb } from "./orders";
import { listPromosByCodes, normalizePromoCode, type Promo } from "./promo";

// commerce-kit:優惠碼目錄(capability "commerce:promos")。
//
// 別的插件想知道一個優惠碼現在的樣子(折扣、用了幾次、開著沒、期限)時問這個,不必知道優惠碼存在哪張表、
// 也不必知道是哪個插件的。提供它的是有優惠碼表的那個插件:
//
//   provides: [{ capability: PROMOS_CAPABILITY, id: "<自己的 id>",
//                create: (services) => createPromoCatalog(services, "<優惠碼表名>", { adminHref: "…" }) }]
//
// 問的一方不看 id:services.providers.find<PromoCatalog>(PROMOS_CAPABILITY, isPromoCatalog)。
// 唯讀。建立、修改、核銷照舊走 promo.ts 的 handler 與 redeemPromo。

export const PROMOS_CAPABILITY = "commerce:promos";

export interface PromoCatalog {
  /**
   * 這些代碼現在的資料;大小寫不拘(先轉成儲存形),沒有的代碼不回。
   * 資料庫讀不到時丟錯,不回空陣列:少一個代碼的意思只有「沒有這個碼」。
   */
  byCodes(codes: readonly string[]): Promise<Promo[]>;
  /** 店家在後台管理優惠碼的那一頁(站內路徑);沒有是 null。 */
  readonly adminHref: string | null;
}

export function isPromoCatalog(impl: unknown): impl is PromoCatalog {
  return impl !== null && typeof impl === "object" && typeof (impl as Partial<PromoCatalog>).byCodes === "function";
}

export function createPromoCatalog(
  deps: CommerceDb,
  table: string,
  options: { adminHref?: string } = {},
): PromoCatalog {
  return {
    adminHref: options.adminHref ?? null,
    byCodes: (codes) => listPromosByCodes(deps, table, codes.map(normalizePromoCode).filter(Boolean)),
  };
}
