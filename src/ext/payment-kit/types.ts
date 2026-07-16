import type { CheckoutRequest, CheckoutSession } from "../capabilities";

// payment-kit:多金流共用引擎的 adapter 契約。
//
// 分工(spec-payment-capability.md §5):
//   - **kit(本資料夾)** 持有所有金流不變的部分:訂單表讀寫、回呼結算(冪等 +
//     payment:succeeded hook)、瀏覽器結果頁、checkout API handler、admin 頁積木。
//   - **adapter(各金流 extension 內)** 只持有會變的部分:金鑰設定讀取、請求
//     驗證、加密/簽章組包、回呼驗簽、回呼解包。每接一家新金流 ≈ 一個 adapter 檔
//     + 一個薄 manifest。
//
// 加密/簽章**必須**是 code(藍新 AES-CBC+SHA256、綠界 CheckMacValue、PAYUNi
// AES-GCM……各家 canonicalization 細節不同,不可能用宣告式設定安全表達)——
// 這就是 payment 類 extension 停在 code kind 的原因。

/** kit 依 core.siteUrl 組好的回呼 URL;siteUrl 未設定時三者皆空字串。 */
export interface GatewayUrls {
  /** server-to-server 付款通知(/api/callback/payment/<providerId>)。 */
  notifyUrl: string;
  /** 使用者瀏覽器導回(/api/callback/payment/<providerId>-return)。 */
  returnUrl: string;
  /** 「返回商店」目標(站台首頁)。 */
  clientBackUrl: string;
}

/** adapter 解析已驗證回呼後的標準化付款結果。 */
export interface ParsedCallback {
  orderNo: string;
  succeeded: boolean;
  tradeNo?: string;
  paymentType?: string;
  payTime?: string;
  /** 解密後原文(kit 存入 raw_result 欄)。 */
  raw: string;
  /** payment:succeeded hook 的 event payload(解析後物件)。 */
  event: unknown;
}

export interface PaymentGatewayAdapter {
  /**
   * 建立結帳:驗證請求(訂單編號字元集/金額/描述上限依 gateway)、讀自家金鑰
   * 設定、組包加密 → 回 CheckoutSession。設定缺失回 { ok:false,
   * error:"not_configured" },不 throw。回 ok 後 kit 才寫入 pending 訂單列。
   */
  buildCheckout(
    req: CheckoutRequest,
    urls: GatewayUrls,
  ): Promise<CheckoutSession>;

  /** 回呼驗簽 —— 這是 ingress 的唯一認證,fail closed(設定缺失一律 false)。 */
  verifyCallback(rawBody: string): Promise<boolean>;

  /** 解析**已驗證**回呼 → ParsedCallback;解不開回 null(kit 記錄後以失敗頁回應)。 */
  parseCallback(rawBody: string): Promise<ParsedCallback | null>;
}
