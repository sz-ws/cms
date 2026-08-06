// commerce-kit 公開入口(server 端)。extension 以 `@/ext/commerce-kit` 取用。
//
// 與 payment-kit 同一慣例:admin 積木(admin.tsx,server)與 client 元件
// (OrderActions.tsx)刻意**不**進這個 barrel —— adminPage 直接
// `import { ... } from "@/ext/commerce-kit/admin"`。

export {
  ORDER_TRANSITIONS,
  ORDER_STATUSES,
  isOrderStatus,
  transitionSources,
} from "./types";
export type {
  OrderStatus,
  OrderLine,
  OrderAmounts,
  CommerceOrder,
} from "./types";
export {
  createOrder,
  getOrder,
  listOrders,
  countByStatus,
  setOrderNote,
  transitionOrder,
  markOrderPaid,
} from "./orders";
export type { CommerceDb, CreateOrderInput, TransitionExtras } from "./orders";
export { createCommerceCheckoutHandler } from "./checkout";
export type {
  CommerceCheckoutOptions,
  CheckoutSuccessBody,
} from "./checkout";
export {
  createTransferReportHandler,
  createTransferVerifyHandler,
  createOrderStatusHandler,
} from "./transfer";
export {
  shippingConfigSchema,
  parseShippingConfig,
  computeShippingOptions,
  createShippingConfigHandler,
} from "./shipping";
export type {
  ShippingConfig,
  ShippingMethod,
  ShippingRule,
  ShippingOption,
  ShippingQuoteInput,
} from "./shipping";
export {
  normalizePromoCode,
  promoDiscount,
  quotePromo,
  redeemPromo,
  restorePromoUse,
  listPromos,
  createPromoQuoteHandler,
  createPromoSaveHandler,
  createPromoDeleteHandler,
} from "./promo";
export type { Promo, PromoType, PromoQuote, PromoRejectReason } from "./promo";
