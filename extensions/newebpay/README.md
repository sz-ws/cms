# 藍新金流(NewebPay)extension

NewebPay MPG 2.0 收款。提供 `payment` capability(`createCheckout`)、付款回呼
驗簽處理(Notify + Return)與訂單記錄。

## 啟用

1. `extensions/registry.ts` 已掛載(import + 陣列一行)。
2. Admin → Extensions → 藍新金流 → 啟用(`kind:"code"`;enable 時自動跑 migration
   建 `ext_newebpay_orders` 表)。
3. 設定頁 Extensions 區填:
   - **Merchant ID**(MS 開頭商店代號)
   - **Hash Key**(32 字元,加密儲存)
   - **Hash IV**(16 字元,加密儲存)
   - **環境**:測試機(ccore.newebpay.com)/ 正式機(core.newebpay.com)
4. 設定頁 General 區的 **Site URL** 必填 —— 用來組回呼 URL。未設定時仍可跳轉
   付款頁,但收不到付款結果,訂單停在「待付款」。

## 回呼 URL(藍新後台不用填 —— 每筆交易動態帶入)

- NotifyURL:`<siteUrl>/api/callback/payment/newebpay`(server-to-server)
- ReturnURL:`<siteUrl>/api/callback/payment/newebpay-return`(瀏覽器導回,回
  HTML 結果頁)

兩者皆走 core 的 unified callback ingress,驗證 = 重算 TradeSha 並 constant-time
比對(fail-closed:金鑰未設定一律拒收)。本機開發時藍新打不進 localhost —— 要測
完整回呼流程需 tunnel(如 `cloudflared tunnel`)並把 Site URL 暫時指向 tunnel。

## 其他模組怎麼收款

```ts
// 設定 core.provider.payment = "newebpay" 後:
const payment = ctx.services.providers.get<PaymentProvider>("payment");
const session = await payment.createCheckout({
  orderNo, amount, description, email,
});
// session.kind === "form-post" → 用 fields 建 <form> auto-submit 到 gatewayUrl
```

付款成功時 hook `payment:succeeded` 會帶 `{ providerId: "newebpay", event }`
(event = 解密後的藍新回傳 JSON)觸發 —— 訂閱它做出貨/開通。

## 測試

- 單元測試:`test/newebpay-crypto.test.ts`(加解密/TradeSha roundtrip)、
  `test/newebpay-callback-route.test.ts`(ingress 端到端:驗簽、訂單狀態、
  Return 模式 HTML 回應)。
- 測試機卡號:`4000-2211-1111-1111`,有效期任意未過期月年,安全碼任意三碼
  (藍新測試環境固定測試卡)。

## 檔案

金流專屬程式只有 `adapter.ts` + `crypto.ts`;引擎(訂單/回呼結算/結果頁/
checkout handler/admin 積木)全部來自 `@/ext/payment-kit`。

| 檔案 | 職責 |
| --- | --- |
| `crypto.ts` | 藍新專屬:AES-256-CBC TradeInfo / TradeSha(WebCrypto,零依賴) |
| `adapter.ts` | PaymentGatewayAdapter:金鑰讀取、請求驗證、組包、驗簽、解包 |
| `admin-page.tsx` | 用 kit 積木組的設定狀態 + 測試付款 + 訂單一覽 |
| `index.ts` | manifest(settings/migrations/provides/adminPages/apiRoutes) |

## 接下一家金流(綠界、PAYUNi…)

照抄這個資料夾的形狀:

1. `extensions/<gateway>/adapter.ts` —— 實作 `PaymentGatewayAdapter` 三個方法
   (該金流的簽章/加密細節放這 + 自己的 `crypto.ts`)。
2. `extensions/<gateway>/index.ts` —— manifest:settings(金鑰欄位,secret)、
   migration(`ext_<gateway>_orders`,欄位照抄)、provides 兩條(notify/return,
   `createPaymentProvider`)、apiRoutes 一條(`createCheckoutHandler`)。
3. `admin-page.tsx` —— 用 `@/ext/payment-kit/admin` 積木組,只改狀態列。
4. registry.ts 掛一行。

kit 引擎、結果頁、訂單結算、測試表單全部直接繼承,不用再寫。
