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
export { ORDER_SEARCH_FIELDS } from "./orders";
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
export { createCommerceAgentTools } from "./agent-tools";
export type {
  CommerceAgentToolsOptions,
  CommerceOrderSummary,
} from "./agent-tools";
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
// 1.49.0:商品目錄(內建宣告式 manifest,開關掛在商店設定)。
export { CATALOG_SETTINGS } from "./catalog";
// 1.50.0:退貨(型別與狀態機、D1 引擎、API)。後台畫面在 returns-admin.tsx(server)與
// ReturnsWorkspace / StartReturnLink(client),同 admin.tsx 慣例不進這個 barrel。
export {
  RETURN_TRANSITIONS,
  RETURN_STATUSES,
  RETURN_REASONS,
  REFUND_METHODS,
  RETURNABLE_ORDER_STATUSES,
  RETURN_SEARCH_FIELDS,
  RETURN_STATUS_SET,
  RESTOCK_CAPABILITY,
  RESTOCK_PROVIDER_ID,
  ReturnError,
  canTransitionReturn,
  isReturnStatus,
  orderReturnBlock,
  orderShipping,
  orderStockReservationId,
  refundCap,
  returnTables,
  suggestedRefund,
} from "./returns";
export type {
  ReturnStatus,
  ReturnReason,
  RefundMethod,
  ReturnLine,
  ReturnRefund,
  ReturnEvent,
  ReturnEventAction,
  ReturnErrorCode,
  RestockProvider,
  RefundOrderAmounts,
  ShopReturn,
} from "./returns";
export { createReturnsEngine, isMissingTableError } from "./returns-engine";
export type {
  ReturnsConfig,
  ReturnsEngine,
  ReturnActor,
  ReturnableLine,
  ReturnableOrder,
  ReturnStock,
  CreateReturnInput,
  TransitionReturnInput,
} from "./returns-engine";
export { createReturnsApiRoutes, RETURNS_ROLE } from "./returns-api";
