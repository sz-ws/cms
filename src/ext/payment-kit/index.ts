// payment-kit 公開入口(server 端)。extension 以 `@/ext/payment-kit` 取用。
//
// 注意:client 元件(CheckoutTestForm)與 admin 積木(admin.tsx)刻意**不**從
// 這裡 re-export —— server-only 的 provider 引擎與 "use client" 元件走同一個
// barrel 會讓 bundler 的邊界判定變髒。adminPage 直接
// `import { ... } from "@/ext/payment-kit/admin"` 與
// `import { CheckoutTestForm } from "@/ext/payment-kit/CheckoutTestForm"`。

export type {
  GatewayUrls,
  ParsedCallback,
  PaymentGatewayAdapter,
} from "./types";
export { createPaymentProvider } from "./provider";
export type { PaymentProviderOptions } from "./provider";
export { createCheckoutHandler } from "./checkout-route";
export { settlePayment } from "./settle";
export type { SettleInput, SettleOutcome } from "./settle";
export {
  createManualPaymentProvider,
  isManualPaymentProvider,
  transferReportSpec,
} from "./manual";
// 1.63.0:回報匯款要填什麼(純函式,client 也能直接 import "@/ext/payment-kit/report-spec")。
export {
  DEFAULT_TRANSFER_REPORT_SPEC,
  REPORT_LIMITS,
  TRANSFER_REPORT_ASKS,
  checkTransferReport,
  normalizeReportSpec,
  reportFields,
  reportSubject,
} from "./report-spec";
export type {
  TransferReportAsk,
  TransferReportCheck,
  TransferReportSpec,
  TransferReportValue,
} from "./report-spec";
export type {
  ManualPaymentProvider,
  ManualPaymentProviderOptions,
  ManualInstructionsResult,
} from "./manual";
export { utf8, hexToBytes, bytesToHex, timingSafeEqual } from "./util";
