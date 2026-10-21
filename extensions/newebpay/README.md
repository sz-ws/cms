# 藍新金流(NewebPay)extension

NewebPay MPG 2.0 收款。提供 `payment` capability(`createCheckout`)、付款回呼
驗簽處理(Notify + Return)與訂單記錄。

## 啟用

1. 掛進 `extensions/registry.ts`(import + 陣列一行)。**預設 bundle 不含這個
   extension** —— 它是台灣特定的金流閘道,不是所有站台都用得到,所以不預裝。
   要裝的話跑 `npx @sz.ws/cms add newebpay`,或自己補那兩行。
2. Admin → Extensions → 藍新金流 → 啟用(`kind:"code"`;enable 時自動跑 migration
   建 `ext_newebpay_orders` 表)。
3. 設定頁「擴充功能 → 藍新金流」填(欄位名稱照藍新商店後台的叫法):
   - **商店代號**(MS 開頭)
   - **HashKey**(32 字元,加密儲存;藍新後台「API 串接金鑰」)
   - **HashIV**(16 字元,加密儲存;同上)
   - **環境**:測試機(ccore.newebpay.com)/ 正式機(core.newebpay.com)。測試機
     要用藍新測試平台(cwww)的商店與金鑰,正式機用正式平台的,兩邊不通用。
4. 設定頁「一般」的 **網站網址**(`core.siteUrl`)必填 —— 用來組回呼 URL。未設定時
   仍可跳轉付款頁,但收不到付款結果,訂單停在「待付款」。
5. 要讓商店結帳頁出現「線上刷卡」:設定頁「擴充功能 → 商店」的「信用卡付款」填
   `newebpay`(`ext.shop.cardProvider`)。

## 回呼 URL(藍新後台不用填 —— 每筆交易動態帶入)

- NotifyURL:`<siteUrl>/api/callback/payment/newebpay`(server-to-server)
- ReturnURL:`<siteUrl>/api/callback/payment/newebpay-return`(瀏覽器導回,回
  HTML 結果頁)

兩者皆走 core 的 unified callback ingress,驗證 = 重算 TradeSha 並 constant-time
比對(fail-closed:金鑰未設定一律拒收)。本機開發時藍新打不進 localhost —— 要測
完整回呼流程需 tunnel(如 `cloudflared tunnel`)並把 Site URL 暫時指向 tunnel。

## 同一張訂單再付一次(0.2.0)

藍新同一商店的商店訂單編號(MerchantOrderNo)不能重複,一送到付款頁就算用過(重新整理付款頁都會回
MPG03008)。所以同一張訂單第二次以後去付款(我的訂單的「繼續付款」、刷卡失敗再試、從付款頁按上一頁回來
再送)送的是新號碼:訂單編號前 21 字 + `_` + 秒數(36 進位)+ 2 個亂數,≤30 字。回呼帶回那個號碼,
adapter 對回原本的訂單(先找完全相同的,再找開頭相同的唯一一筆)。叫用的一方每次都要重新
`createCheckout`,不能把上次的表單存起來再送 —— 表單裡還有當時的 TimeStamp。

只開信用卡(`CREDIT=1`):結帳頁寫的是「線上刷卡」;ATM、超商代碼是先取號、幾天後才付,可能付在訂單
過了付款期限、被取消之後。

## 什麼時候算付清(0.2.2)

回呼的簽章對、解得開,而且藍新說 `SUCCESS` 之外,還要有付款時間(`PayTime`)、金額(`Amt`)跟這張訂單一樣,
才把訂單結算成已付款(藍新官方 WooCommerce 外掛也這樣查)。對不上時錢可能已經扣了,不算失敗:客人看到
「付款結果確認中」,server-to-server 通知回 500,訂單維持待付款,錯誤紀錄寫著藍新交易序號與兩邊的金額。

藍新回呼的 TradeInfo 是 32 bytes 一塊補齊的 PKCS7(官方範例 `addpadding($string, $blocksize = 32)`),
`crypto.ts` 的 `decryptTradeInfo` 自己去填充,不交給 WebCrypto 檢查(0.2.1)。

## 付款之後客人回到哪裡

ReturnURL 與 ClientBackURL(付款頁的「返回商店」)預設是 kit 的結果頁與首頁。認得這張訂單的插件填 core
1.78.0 的 `PaymentReturn` 插槽(`@/ext/payment-kit`)時,改成 303 轉去它給的站內頁(例如商城營運的
`/shop/orders?order=…&payment=paid|failed|back`)。

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
