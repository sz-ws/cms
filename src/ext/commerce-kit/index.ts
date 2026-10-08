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
  parseOrderMeta,
} from "./orders";
export type { CommerceDb, CreateOrderInput, TransitionExtras } from "./orders";
// 1.63.0:訂單管理插件的合約(commerce:orders)。ManagedCommerceProvider 是它的舊名(./managed,2.0 拿掉)。
export {
  ORDERS_CAPABILITY,
  OrderManagedError,
  checkoutPausedResponse,
  customerOrderManagedResponse,
  hasManagedOrders,
  orderManagedResponse,
  resolveOrderOwner,
  storefrontOf,
} from "./order-manager";
export type {
  CustomerOrderAnswer,
  CustomerOrderInput,
  OrderManager,
  OrderOwner,
  OrderStorefront,
  TransferReportInput,
} from "./order-manager";
// 這個人是不是這張訂單的客人(公開路由讓客人自己對訂單做事之前先問;訂單管理插件的訂單問它的 customerOrder())。
// startOrderEmailProof:用「訂單編號 + Email」認人的額度(只算猜錯的);插件自己的查單用同一份。
export { ORDER_EMAIL_PROOF_LIMITS, resolveCustomerOrder, startOrderEmailProof } from "./customer-order";
export type { CustomerOrderProof, OrderEmailProofAttempt } from "./customer-order";
export type { ManagedCommerceProvider } from "./managed";
export { ORDER_SEARCH_FIELDS } from "./orders";
export { createCommerceCheckoutHandler } from "./checkout";
// 1.63.0:結帳欄位(capability commerce:checkout-fields)與訂單 meta。瀏覽器端的預先帶入在
// checkout-prefill.ts(client 直接 import,不進這個 barrel)。
export {
  CHECKOUT_FIELDS_CAPABILITY,
  MAX_CHECKOUT_FIELDS,
  MAX_FIELD_LENGTH,
  checkoutFieldsBodySchema,
  fieldInvalidResponse,
  listCheckoutFields,
  publicCheckoutFields,
  validateCheckoutFields,
} from "./checkout-fields";
export type {
  CheckoutField,
  CheckoutFieldCheck,
  CheckoutFieldDraft,
  CheckoutFieldProvider,
  CheckoutFieldsResult,
  DeclaredCheckoutField,
  FieldInvalidBody,
  PublicCheckoutField,
} from "./checkout-fields";
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
  shippingRegions,
  DEFAULT_REGIONS,
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
  listPromosByCodes,
  createPromoQuoteHandler,
  createPromoSaveHandler,
  createPromoDeleteHandler,
} from "./promo";
export type { Promo, PromoType, PromoQuote, PromoRejectReason } from "./promo";
// 優惠碼目錄(capability commerce:promos):別的插件問一個代碼現在的樣子。
export { PROMOS_CAPABILITY, createPromoCatalog, isPromoCatalog } from "./promo-catalog";
export type { PromoCatalog } from "./promo-catalog";
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
  ReturnError,
  canTransitionReturn,
  isRestockProvider,
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
/** @deprecated 1.63.0 — remove in 2.0. The restock provider is found by capability (isRestockProvider). */
export { RESTOCK_PROVIDER_ID } from "./returns-legacy";
export type {
  ReturnsConfig,
  ReturnsEngine,
  ReturnActor,
  ReturnableLine,
  ReturnableOrder,
  ReturnStock,
  CreateReturnInput,
  CustomerReturnInput,
  TransitionReturnInput,
} from "./returns-engine";
export { createReturnsApiRoutes, RETURNS_ROLE } from "./returns-api";
// 客人自己申請退貨:公開路由(returns/customer)、設定值怎麼讀、後台怎麼認出是客人申請的。
export { createCustomerReturnRoutes, CUSTOMER_RETURN_LIMITS } from "./returns-customer";
export type { CustomerReturnsOptions } from "./returns-customer";
export {
  CUSTOMER_ACTOR,
  CUSTOMER_RETURN_MAX_DAYS,
  askedByCustomer,
  customerActorId,
  customerReturnDays,
  customerReturnDeadline,
  isCustomerActor,
} from "./returns";
export type { CustomerReturnBlock, CustomerReturnSummary, CustomerReturnView } from "./returns";
// 1.62.0:儀表板的共用數字(營業額)。
export { REVENUE } from "./metrics";
