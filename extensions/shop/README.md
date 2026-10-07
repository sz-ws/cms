# shop — 商店(commerce-kit 接線層)

購物車、結帳、訂單管理。引擎在 `src/ext/commerce-kit/`(訂單狀態機、伺服器計價、
匯款對帳流程、admin 積木),本資料夾只有接線:表名、settings、route 宣告、
admin 頁組裝、`payment:succeeded` 綁定。設計說明見 `docs/spec-commerce-kit.md`。

## 需要的東西

- **商品**:commerce-kit 內建的商品目錄(`catalog.product`,含 `name` + `price`;分類
  `catalog.category`)。core 1.49.0 起商店啟用就有,不用另外安裝;設定 `catalog` 關掉會
  收起商品目錄,資料保留。
- **收款**(payment capability,至少一種):
  - 匯款:`extensions/banktransfer`(manual provider,人工對帳;回報要填什麼在它的設定)。
  - 刷卡:任一 gateway provider(如 `extensions/newebpay`),
    設定 `ext.shop.cardProvider` 指向其 providerId。
- **選配**:訂單管理插件(`commerce:orders`,見下方「訂單管理插件」)與提供結帳欄位的插件
  (`commerce:checkout-fields`,見「結帳欄位」)。

## 安裝

不預裝(同 newebpay)。`extensions/registry.ts` 加:

```ts
import { shop } from "./shop";
import { banktransfer } from "./banktransfer";
// registry 陣列加入 shop, banktransfer
```

rebuild + deploy 後在 `/admin/extensions` 啟用,到設定頁填銀行帳戶。

## 設定

全部在後台「設定 → 商店」;存 settings 表,key 為 `ext.shop.<key>`。定義在
`index.ts`(收款)與 `checkout-options.ts`(結帳頁開關)。

| key | 類型 | 預設 | 作用 |
|---|---|---|---|
| `catalog` | boolean | `true` | 商品目錄(後台商品、分類頁與前台 `/products`)。`false` = 收起來,商品與分類保留;定義在 `commerce-kit/catalog.ts`。 |
| `cardProvider` | text | `""` | 刷卡的 gateway provider id(如 `newebpay`)。空 = 結帳頁不出現刷卡。 |
| `transferProvider` | text | `banktransfer` | 匯款的 manual provider id。空 = 結帳頁不出現匯款。 |
| `shippingConfig` | (JSON) | `""` | 由 `/admin/ext/shop/shipping` 頁維護,不在設定頁手填。空 = 不啟用運費。 |
| `requireContact` | boolean | `false` | 電話與收件地址必填(表單層)。訂單管理插件接手結帳時照它的 `storefront()`。 |
| `checkoutNotice` | textarea | `""` | 結帳頁最上方的說明文字,保留換行。空 = 不顯示。 |

結帳頁開關的讀取順序:`public-pages.tsx` 在伺服器讀出原始值 →
`resolveCheckoutOptions()` 正規化(壞值退回預設,絕不擋結帳)→ 交給 `CheckoutView`。
`CheckoutView` 對 props 再跑一次同一個函式,所以自訂殼層少給幾個 prop 也會得到一致
的預設。優先序(由 `test/shop-checkout-options.test.ts` 鎖住):

- 沒有訂單管理插件:`signedIn`、`guestCheckout` 一律 false,沒有訂單頁;`requireContact` 照設定。
- 有訂單管理插件:`requireContact` 照它說的(沒說 = 必填);訂單頁只收站內路徑。

**沒有「是否交給訂單管理插件」的開關**,理由見下方。

## 動線

```
訪客:catalog 商品頁(AddToCartButton)→ /shop/cart → /shop/checkout
  刷卡:form-post/redirect 跳轉 gateway → 回呼 → 訂單 paid
  匯款:出示帳號(kind:"manual")→ 客人回報匯款 → 訂單 awaiting_verify
店家:/admin/ext/shop(訂單)· /admin/ext/shop/verify(對帳佇列)
  核可 → settleManual → payment:succeeded → 訂單 paid → 出貨 → 完成
訂單管理插件接手時:同一個結帳頁,結帳與訂單狀態由它處理(見下節)
```

人工轉帳查不到帳,到帳與否只有店家的銀行看得到 —— 所以匯款的狀態切換是
**人工一級公民**,兩條路並存:客人回報匯款(→ 待對帳),或 admin 在對帳佇列
「等待匯款(未回報)」區/訂單列直接**標記已收款**,不必等客人回報。

## 訂單管理插件(`commerce:orders`,core 1.63.0)

一個插件可以接手商店的結帳與訂單處理:以 capability `commerce:orders` 註冊 provider,
provider id = 訂單表名 `ext_shop_orders`,實作 commerce-kit 的 `OrderManager`
(`src/ext/commerce-kit/order-manager.ts`):

```ts
interface OrderManager {
  checkout(req, ctx): Promise<Response>;            // 整筆結帳
  transition(orderNo, to, extras): Promise<boolean>; // 付款結算、後台與 AI 的狀態動作
  storefront?(): Promise<{ signIn: "required" | "optional"; requireContact: boolean; ordersHref: string | null }>;
  reportTransfer?(input: { orderNo; reference?; payerName?; email? }, req, ctx): Promise<Response>;
}
```

它建的訂單在 `managed_by` 欄寫上自己的 extension id(migration `0007_managed_by`)。
core 看這一欄決定一筆訂單歸誰:

| 情況 | 結果 |
|---|---|
| 結帳時有這個 provider | 整筆結帳交給 `checkout()` |
| 結帳時沒有,但有 `managed_by` 有值的訂單 | 503 `checkout_paused`(「目前暫停結帳，請稍後再試。」)—— 不讓一半的訂單走商店、一半等插件回來 |
| `managed_by` 有值、插件啟用中 | 轉移交給 `transition()`、匯款回報交給 `reportTransfer()`;對帳佇列的核帳回 409 `order_managed` |
| `managed_by` 有值、插件停用了 | 409 `order_managed`:「這筆訂單由「{插件名稱}」處理，請先啟用它。」(名稱讀那個插件的 manifest) |
| `managed_by` 是空的 | 商店自己處理 |

2.0 以前,還沒按「套用更新」、訂單列還沒有 `managed_by` 的站,照舊看
`ext_shop_orders_managed` 標記表(`commerce-kit/legacy-ownership.ts`)。

商店這邊只做一件事:`public-pages.tsx` 看 registry 有沒有這個 provider,有就照
`storefront()` 畫結帳頁(沒有 `storefront()` 的插件照舊問 `guestCheckout()`,2.0 拿掉)。
**所以沒有 shop 端的開關** —— 若加一個「關閉」,頁面會顯示舊表單、伺服器仍交給插件,
兩邊對不上。要退出,在 `/admin/extensions` 停用那個插件(它自己決定停不停得了);停用後
結帳會停在上面的 503,直到重新啟用或另行處理它的訂單。

### 結帳頁的差異

| | 商店自己處理 | 訂單管理插件接手 |
|---|---|---|
| 身分 | 訪客,免登入 | `signIn: "required"`:要登入;沒登入的人看不到表單,只有「請先登入會員，登入後就能繼續結帳。」、「登入」按鈕(連到 `/login?next=/shop/checkout`,給了 `onSignIn` 就呼叫它)與訂單摘要(0.11.0);`"optional"`:不擋,頂端「已經是會員？登入」 |
| 電話、收件地址 | 選填(`requireContact` 可改必填) | 照 `requireContact`(沒說 = 必填) |
| 「我的訂單」連結 | 無 | 有 `ordersHref` 才有 |
| 匯款成立後的說明 | 「請於三日內匯款」 | 結帳回覆有 `expiresAt`:「請在 {期限} 前匯款」(站台時區);沒有時,有訂單頁:「請到「我的訂單」查看付款期限」;沒有:「請匯款到以下帳戶」 |

結帳成功的回覆是 `{ ok: true, orderNo, session, expiresAt? }`(commerce-kit `CheckoutSuccessBody`)。`expiresAt`
(0.11.0,epoch ms)是付款期限,選填:接手的插件有期限就帶,結帳完成頁寫在匯款指示上面;沒帶(商店自己的訂單、
較舊的插件)照上表的說法。

結帳 body 只有一種(`checkout-request.ts`):`requestId`(同一份表單重送用同一個 id,
換內容才換)、`items`、聯絡資料、`region`、`shippingMethodId`(沒有選項時送空字串)、
`promoCode`、`method`、`fields`(結帳欄位)。商店自己的結帳收下 `requestId` 但不用它。
接手的插件可以有更嚴的限制(例如必填電話),它回的中文句子接在「結帳失敗：」後面顯示。

## 結帳欄位(`commerce:checkout-fields`,core 1.63.0)

插件以 capability `commerce:checkout-fields` 註冊 provider,`fields()` 回傳要加在結帳頁的
欄位(`key`、`label`、`input: "text" | "textarea" | "hidden"`、`maxLength`、`required`、
選填的 `validate(value, draft)` 與錯誤訊息)。provider id 是命名空間:欄位在 body 與訂單
的名字是 `<providerId>.<key>`。

- 結帳頁照順序畫出來;`hidden` 的不畫。瀏覽器記下的值(commerce-kit `checkout-prefill.ts`,
  localStorage `checkout.prefill.v1`,例如別的頁面記下的連結參數)先帶入。
- 伺服器用 `validateCheckoutFields` 檢查(商店自己的結帳在建立付款之前;接手的插件在它的
  `checkout()` 裡),不過回 422 `{ error: "field_invalid", field, code, message }`。結帳頁
  顯示 `message`、忘掉那個記下的值;`hidden` 的一併清掉,請客人再送一次。
- 值存在訂單的 `meta`(JSON,migration `0006_order_meta`);後台訂單列表在「內容」底下
  列出,名稱用宣告它的插件給的。

## 回報匯款(0.8.0 起在結局頁;0.9.0 要填什麼照付款方式)

匯款訂單的結局頁在匯款指示底下放回報表單(`TransferReportForm.tsx`,送出規則在
`transfer-report.ts`)。

- **要填什麼**:商店匯款方式(`transferProvider`)的 `reportSpec()`(payment-kit
  `report-spec.ts`):參考碼(名稱、位數;0 位 = 不限格式)、匯款人姓名、擇一或兩個都要。
  銀行轉帳在自己的設定頁讓店家選,預設是帳號末五碼、5 位數字。送出前檢查一次,伺服器照同一份
  規則再檢查。
- **送到哪裡**:一律 `POST /api/ext/shop/transfer-report`
  (`{ orderNo, reference?, payerName?, email? }`)。`email` 是下單的 Email,證明回報的是下單的人
  (這一頁剛送出結帳表單,不另外發憑證;Email 不印在頁面上):商店自己的訂單一律帶(core 1.63.0 起
  Email 對不上、又不是登入的本人或管理員就回 `not_found`);訂單管理插件的訂單由 core 轉給它的
  `reportTransfer()`,會員看登入的人(不帶 Email)、訪客帶下單 Email(`transfer-report.ts` 的
  `reportEmailFor`)。舊的 `last5` 欄位 2.0 以前照樣收。
- **只送一次**:送出中、送成功之後再按都不會再送(`reportOnce`);失敗可以改了再送。
- 回報之後說「已回報匯款，等店家確認」,有訂單頁就連過去,沒有就「返回網站」。
- 參考碼存在 `transfer_last5` 欄(名字沿用),匯款人姓名在 `transfer_payer`(migration
  `0005_transfer_payer`)。對帳佇列照付款方式的名稱顯示。

## 錯誤碼

`CheckoutView` 把 `error` 對成中文(`checkout-request.ts`);對不到的顯示為「結帳失敗:…」。

商店自己的結帳(commerce-kit `checkout.ts`):

| `error` | 狀態碼 | 說明 |
|---|---|---|
| `invalid_input` | 400 | 欄位缺漏或格式不對 |
| `unknown_product` / `unpriced_product` | 422 | 商品下架或沒有價格(帶 `productId`) |
| `invalid_shipping` / `promo_invalid` / `method_not_enabled` / `invalid_total` | 422 | 配送、優惠碼(帶 `reason`)、付款方式、金額不成立 |
| `field_invalid` | 422 | 結帳欄位不過(帶 `field`、`code`、`message`) |
| `not_configured` 等 session 錯誤 | 422 | 付款 provider 建立 session 失敗,body 即 session(`ok:false`) |
| `not_available` | 503 | 付款 provider 不在 registry |
| `checkout_paused` | 503 | 有訂單管理插件管過的訂單,但它現在沒啟用 |
| `rate_limited` | 429 | 每 IP 15 分鐘 20 次 |

訂單管理插件接手時,錯誤由它回(見它的說明)。

### 訂單狀態操作分工

| 動作 | 商店自己的訂單 | 訂單管理插件的訂單 |
|---|---|---|
| 客人回報匯款 | `POST /api/ext/shop/transfer-report` | 同一個端點,core 轉給 `reportTransfer()`;插件沒有它時回 409 `order_managed` |
| 標記已收款(paid) | 對帳佇列核可 → `settleManual` | 由插件處理;對帳佇列回 409 `order_managed` |
| 出貨、完成、取消、退款 | 訂單頁 | 訂單頁與 agent tool 轉交 `transition()`,插件自己決定收不收 |

### 停用與卸載

- core 不讓你在依賴它的插件啟用中停用 shop(`requiresExtensions` 反查,
  `src/ext/code-lifecycle.ts`):會得到「尚有啟用中的插件依賴此插件」。先停用那些插件,再停用 shop。
- shop 的 `uninstall` 只丟 `ext_shop_orders`、`ext_shop_promos` 與三張退貨表
  (`ext_shop_return_*`;放回庫存的流水帳在庫存插件的表裡,不受影響)。訂單管理插件自己的表
  屬於它;裝過它的站實際上也不該卸載 shop。

## 運費與優惠碼(Phase 3–4)

- **運費**:/admin/ext/shop/shipping 設定配送方式 + 規則(滿額免運、離島加收…,
  順序即優先序),右欄即時試算。設定存 `ext.shop.shippingConfig`;沒設定 =
  不啟用運費(數位商品/自取直接留空)。結帳頁把所有方式算好列給客人挑。
- **收件地區**(0.9.0):同一頁的「收件地區」一行一個,是結帳頁收件地區的選項,也是規則
  「限地區」比對的字(存在運費設定的 `regions`,最多 60 個)。沒設就是台灣縣市
  (commerce-kit `DEFAULT_REGIONS`)。
- **優惠碼**:/admin/ext/shop/promos 建碼(打折 % / 折抵 / 免運 + 低消 + 次數
  上限)。結帳頁輸入後即時預覽,送單時伺服器原子核銷 —— 搶最後一次用量
  只有一單成立。
- 金額拆帳:`subtotal − discount + shipping = total`,全部伺服器算,快照入單。金額是整數的
  「元」,照站台幣別(`core.currency`)寫;改幣別只換寫法,不換算。

訂單狀態機(`commerce-kit/types.ts` 唯一定義):
`pending_payment → (awaiting_verify ⇄) → paid → shipped → completed`,
另 `cancelled`(收款前)與 `refunded`(記帳用;gateway 退款 API 刻意不做)。

## 退貨(0.6.0)

後台 `/admin/ext/shop/returns`「退貨管理」。已出貨、已完成的訂單才能退貨;還沒出貨的訂單
走取消(商店自己的訂單在訂單頁,訂單管理插件的訂單在它的頁面)。店家代客人建立,客人自己
申請的表單還沒有。

```
申請中 → 已同意 → 已收到退貨 → 已退款 → 已完成
   │         ├→ 已退款(直接退款,不收回商品)
   │         └→ 已取消
   ├→ 已拒絕
   └→ 已取消                已收到退貨 → 已完成(不退款結案,例如換貨)
```

- **一筆退貨屬於一張訂單**:哪幾項、各幾件、原因、說明、申請退款金額。品項名稱與單價從
  訂單快照。同一項商品在所有未拒絕、未取消的退貨裡加起來,不會超過訂購件數 —— 兩筆同時
  建立搶最後一件,只有一筆成立(batch 內再算一次)。
- **不改訂單狀態**。部分退貨很常見,訂單照樣是「已完成」;要看退了什麼,看它的退貨。
  訂單管理插件的訂單因此也適用,不必繞過它的狀態規則。
- **處理紀錄**:建立與每一步都記下誰、什麼時候、備註(`ext_shop_return_events`,
  人名當下存一份)。
- **放回庫存**:有插件提供 capability `inventory`(core 1.63.0 起用 `find()` 找唯一一個
  長得像 `RestockProvider` 的,不看 id)時,「收到退貨」時勾「放回庫存」再逐項填件數
  (預設不放回:收回來的不一定能再賣),和狀態變更同一個 D1 batch(ledger-kit)。只放回這張
  訂單真的從庫存扣走的:訂單的預留 `<訂單編號>:<商品 id>`(`orderStockReservationId`)要是
  已扣下(captured)。沒扣過庫存的訂單不給放回(放回去會憑空多出庫存)。沒有庫存帳的商品
  不能放回(不會憑空開始管它的庫存)。沒有庫存插件(或不只一個)就只記錄。
- **退款只記錄**:金額、方式(原付款方式退回、銀行轉帳、現金、其他)、備註。CMS 不會把錢
  退回金流或銀行,畫面上照實寫;同一張訂單的退款合計不超過訂單金額。建立退貨時的預設
  金額是退回件數的實付價格(按訂單折扣比例折算,不含運費)。申請金額與實際退款的上限
  都是退回這幾件的商品金額(單價 × 件數)加上這張訂單的運費(`refundCap`;運費 =
  訂單金額 −(商品金額 − 折扣),`orderShipping`),也不超過訂單還沒退的金額:從運費 150
  的訂單退一件 150 元的商品,最多退 300,不是整張訂單的金額。整張退、或瑕疵品由店家負擔
  運費時,可以把預設金額改成連運費一起退。
- **權限**:API(`returns/…`,見 `commerce-kit/returns-api.ts`)跟著退貨管理頁(`accessAs`):
  自訂角色要這一頁的「檢視」才看得到,「編輯」才能建立與處理退貨;只能看的角色沒有
  「新增退貨」與下一步。預設角色照舊只有管理員。
- **搜尋**:頂欄可找退貨編號、訂單編號、姓名、電話與建立期間;⌘K 也找得到。狀態名稱在
  狀態組 `shop:returns`,站台可用 `filter:statusSets` 改名。
- **從訂單開退貨**:訂單列表的「申請退貨」帶著訂單編號打開「新增退貨」(`?order=`)。只有能在
  退貨管理建立退貨的角色看得到;商品都已經申請退貨的訂單不給(0.7.0)。

表(migration `0004_returns`):`ext_shop_return_requests`(退貨)、`ext_shop_return_events`
(處理紀錄)、`ext_shop_return_operations`(ledger-kit 交易收據)。

## 客製店面前端(這是預期行為)

店面 UI **刻意全部住在本資料夾**,而引擎(狀態機/計價/對帳/API)在
`src/ext/commerce-kit/` —— 邊界就是「引擎不改、外觀隨便改」:

- `CartView.tsx` / `CheckoutView.tsx`(與 `CheckoutParts.tsx`、`CheckoutResult.tsx`)/
  `AddToCartButton.tsx`:逐站直接改(extensions/ 本來就是 per-site 版控的檔案,同
  registry.ts 的定位)。
- `cart-store.ts` 是資料層(subscribe/snapshot/addToCart/setQty/clearCart),
  自訂 UI 只管消費它,不必自己碰 localStorage。
- `checkout-options.ts` 是開關層:設定定義 + `resolveCheckoutOptions()`,沒有 React,
  自訂殼層直接沿用即可拿到相同的預設與優先序。`checkout-request.ts` 是送出的 body 與錯誤說法。
- 換整頁版面 = 改 `public-pages.tsx` 的殼,或整組換掉 publicRoutes 的 component。
- 只換內容不換版面(0.12.0):購物車頁與結帳頁的內容各是一個插槽(`slots.ts` 的 `ShopCart`、`ShopCheckout`,
  core 1.74.0)。別的插件或站台那一層用 `wrap` 填:拿得到這一頁的 props 與原本的內容(`children`),可以照畫、
  在外面多包一層、或換成自己的。例:會員插件在結帳表單前多一步(訪客先確認 Email);數量有規矩的店換成
  自己的購物車。不必另開一個路由檔把這一頁重組一次。
- `CheckoutView` 的 props:`cardEnabled`、`transferEnabled`(必填);`shippingConfig`、
  `promoEnabled`、`managedOrders`、`signedIn`、`guestCheckout`、`ordersHref`、`requireContact`、
  `notice`、`contact`、`reportSpec`、`fields`(選填,預設同 `resolveCheckoutOptions`);`signInHref`
  (「登入」連去哪,預設 `/login?next=/shop/checkout`)、`shopHref`(空的結帳頁「繼續購物」;元件自己的預設是 `/`,
  經由這個插件的兩頁畫出來時,商品目錄開著就是它的列表頁 `/products`,0.12.0)。
  0.7.0 另有兩個函式 prop,只能從 client 元件傳:`onSignIn`(按「登入」時做的事)、
  `afterOrder({ orderNo, email })`(匯款訂單結局頁下面多放的東西)。
- 0.11.0 起結帳頁的標題(h1)由 `CheckoutView` 畫(`PageHeader.tsx`):填表時「結帳」+「回購物車」,成立訂單
  之後「訂單已成立」。自己的殼不要再放一個標題。

## 商品頁掛加入購物車鈕

`AddToCartButton` 是 client 元件,給站台自己的商品頁使用
(照 `extensions/gallery-enhance/` 的 override 模式,對
`public:catalog.product:detail` 註冊自訂 detail,內嵌
`<AddToCartButton productId={entry.id} name={…} unitPrice={…} />`)。

## 刻意不做

- 伺服器端購物車(localStorage 就夠;結帳時伺服器重新計價,永不信 client)。
- 庫存、會員查單與依訂單計算的獎勵**不在 shop 裡做**:由訂單管理插件與其他插件提供;
  它們讀訂單的 `meta`。沒有「訂單成立時」的 hook:要和訂單同一個 batch 寫的東西屬於
  接手訂單的插件。
- 團購(§7.2)未動。
- 訂單查詢頁:商店自己沒有(客人記訂單編號即可);訂單管理插件可以提供(`ordersHref`)。

## 升級到 0.9.0(core 1.63.0)

- 部署後到「擴充功能」按商店的「套用更新」(`0005_transfer_payer`、`0006_order_meta`、
  `0007_managed_by`);和其他插件的「套用更新」誰先誰後都可以。在那之前結帳、回報與轉移照舊運作:
  新欄位只在表上有這一欄、而且有值時才寫(core 的 `orderColumns`),訂單歸誰照舊看舊的標記表。
- 回報要填什麼改在匯款方式的設定(銀行轉帳 0.2.0),預設和以前一樣是帳號末五碼。
- 自訂過 `CheckoutView` 的站:受管訂單專用的兩個 props(額外欄位的模式、回報要填什麼)拿掉了,
  改用 `fields` 與 `reportSpec`,另外多了 `ordersHref`;body 一律帶 `requestId`,額外欄位在
  `fields`;回報一律打 `/api/ext/shop/transfer-report`。

## 版本

- **0.12.0**(core 1.74.0):
  - 購物車頁與結帳頁的內容各是一個插槽(`slots.ts`),見上面「只換內容不換版面」。沒有人填時跟原本一樣。
  - 「繼續購物」沒指定時,商品目錄開著就連它的列表頁(`/products`);原本一律回首頁。站台直接畫這兩頁、
    自己給 `shopHref` 的照舊用給的。
  - 沒有新的設定與 migration。
- **0.11.1**:`CheckoutView` 的 `contact` 多收 `phone`、`address`(站台或別的插件已經知道的,例如會員存的),
  先帶入,照樣能改。
- **0.11.0**:
  - 要登入才能結帳(訂單管理插件的 `signIn: "required"`)、還沒登入:不畫表單,改成一句「請先登入會員，
    登入後就能繼續結帳。」、「登入」按鈕(`signInHref`,帶 `?next=`)與訂單摘要。以前表單填得完,按「成立訂單」
    才說要登入,登入回來電話、地址都要重填。訪客也能結帳時照舊。伺服器還是回 `unauthorized`(例如登入過期)時,
    錯誤旁邊有「登入」。
  - 姓名、Email、電話、收件地區、收件地址有 `autocomplete`(`name`、`email`、`tel`、`address-level1`、
    `street-address`),瀏覽器能自動填。優惠碼欄拿掉範例代碼(客人會照著打)。
  - 結帳頁的標題改由 `CheckoutView` 畫:成立訂單之後是「訂單已成立」,沒有「回購物車」。付款期限:結帳回覆有
    `expiresAt`(選填,commerce-kit `CheckoutSuccessBody`)時寫「請在 {期限} 前匯款到以下帳戶」,照站台時區。
    每行匯款指示(銀行、帳號、戶名、金額、訂單編號…)旁邊有「複製」。
  - 購物車空了(例如成立訂單之後重新整理)說「購物車是空的。」並連到 `shopHref`(`CheckoutView` 與
    `ShopCheckoutPage` 收,沒給回首頁),不再叫人去空的購物車。
  - 站台可以自己組結帳頁(例如在表單前先驗證 Email):`loadShopCheckoutProps({ shopHref })` 回 `CheckoutView`
    要的全部資料(伺服器),`ShopPageShell` 是商店頁的版面;兩個都從 `public-pages.tsx` 匯出。`CheckoutView`
    多 `emailLocked`(Email 已由頁面確認過,照 `contact.email` 送出、不能改)與 `onChangeEmail`(給了就在旁邊放
    「改用其他 Email」,由頁面決定怎麼換)。
  - 沒有 migration,沒有新的設定,沒有 core 的新需求。
- **0.10.1**:回報匯款的參考碼格式不對時,結帳完成頁說要填幾位數字(例如「帳號末五碼要填 5 位數字」),
  不再先跳出瀏覽器的「格式不符」。
- **0.10.0**:
  - 空的購物車有「繼續購物」。`CartView` 與 `ShopCartPage` 收 `shopHref`:站台的殼給自己的商品頁,
    沒給回首頁。
  - 結帳頁的「登入」直接連到網站的登入頁(有插件宣告 `signInPage` 時),帶 `?next=/shop/checkout`,
    登入完回結帳頁;`CheckoutView` 收 `signInHref`,沒給是 `/login`(它也會轉過去)。
  - 沒有 migration,沒有新的設定。
- **0.9.0**:需要 core 1.63.0。
  - 訂單管理插件改看 `commerce:orders` provider(不看插件 id),結帳頁照它的 `storefront()`
    畫;「我的訂單」只在它給了 `ordersHref`(同站路徑,沒有反斜線)時出現。回報匯款一律送商店的
    端點,由 core 轉給接手的插件;商店自己的訂單回報時帶下單 Email。
  - 結帳欄位(`commerce:checkout-fields`):插件宣告的欄位畫在結帳頁,值存在訂單 `meta`,
    後台訂單列表列出。商店原本那個只在受管訂單有用的欄位與它的設定拿掉了(改由提供它的插件宣告)。
  - 回報匯款要填什麼照匯款方式的 `reportSpec()`;結局頁不論誰接手都是同一個表單。
    對帳佇列照付款方式的名稱顯示回報內容,多顯示匯款人姓名。
  - 收件地區可以在運費頁改(`regions`);金額照站台幣別寫。
  - migrations `0005_transfer_payer`、`0006_order_meta`、`0007_managed_by`。
  - 拆檔:`checkout-request.ts`、`CheckoutParts.tsx`、`CheckoutResult.tsx`、`shop-providers.ts`。
- **0.8.0**:需要 core 1.52.0(沒有新的需求)。
  - 受管訂單的匯款結局頁直接回報:欄位照接手訂單那一邊的設定(末五碼、姓名、擇一或兩個
    都要),會員與訪客各走它現成的端點;回報後說「已回報匯款，等店家確認」。
  - 新增 `transfer-report.ts`、`TransferReportForm.tsx`、`checkout-styles.ts`;新增測試
    `test/shop-transfer-report.test.ts`、`test/shop-transfer-report-view.test.tsx`。
- **0.7.0**:需要 core 1.52.0。
  - 訪客結帳:受管訂單那一邊開放時,沒登入也能結帳,頂端改成「已經是會員？登入」,匯款訂單的
    結局頁請客人用訂單編號查詢。`resolveCheckoutOptions` 多一個 `guestCheckout`;`CheckoutView`
    多 `onSignIn`、`afterOrder` 兩個選填 prop。
  - 已登入的人結帳時,Email 與姓名先帶入帳號上的資料(`checkoutContact`)。
  - 在「角色與權限」只拿到「檢視」的角色,訂單、對帳佇列、運費、優惠碼與退貨管理只列出
    資料(core `canEditCurrentPage()`)。打不開對帳佇列的角色,訂單頁不顯示「待對帳」。訂單頁的
    「申請退貨」只給能在退貨管理建立退貨的角色;商品都已經申請退貨的訂單改說「商品都已申請退貨」。
  - 結帳頁、訂單、對帳佇列、運費與優惠碼頁的中文用全形標點;代碼欄的範例改成 EXAMPLE10。
  - 結帳完成頁的匯款指示、訂單編號與優惠碼太長時在手機上換行(`InstructionLines`)。
  - 受管訂單的結帳頁頂端改成「已登入會員 · 我的訂單」與「結帳前請先登入會員 · 我的訂單」。
- **0.6.0**:需要 core 1.50.0。退貨管理(見「退貨」一節):migration `0004_returns`、後台頁
  `returns`、狀態組 `shop:returns`、四個 admin API(`returns/…`);訂單列表的已出貨、已完成
  訂單多一個「申請退貨」。要按「套用更新」才會建表。運費、優惠碼、對帳、訂單狀態與退貨的
  API 各自跟著對應的後台頁(`accessAs`)。
- **0.5.0**:需要 core 1.49.0。商品目錄併進 commerce-kit:商店啟用就有商品與分類
  (`catalog.product`、`catalog.category`),不再從 registry 安裝。新設定 `catalog` 可以關掉它。
- **0.4.0**:需要 core 1.48.0。提供公開 feed `recentPurchases`(最近 20 筆已付款、已出貨、
  已完成的訂單,每筆只有第一個品項名稱、其他品項數、下單時間),宣告式插件的 script 以
  `{{feed.shop.recentPurchases}}` 取用。姓名、聯絡方式、地址、金額都不會出去。
- **0.3.0**:需要 core 1.40.0。訂單頁宣告搜尋:頂欄可用姓名、電話、Email 或訂單編號找訂單,
  並篩選下單期間;⌘K 全站搜尋也找得到訂單。頁面標題跟著側欄名稱。
- **0.2.2**:設定頁的收款欄位改名為「信用卡付款」「匯款付款」,說明改寫成白話。
- **0.2.1**:後台側欄收在「商務」一區,訂單、對帳佇列、運費、優惠碼合成一個「商店」資料夾。
- **0.2.0**
  - 有插件接手訂單(受管訂單)時,結帳交給它;結帳頁依它切換:需登入、電話與地址必填、
    「我的訂單」連結、匯款回報端點。未安裝時行為不變。
  - 新設定 `requireContact`(電話與地址必填)、`checkoutNotice`(結帳頁說明);讀取與優先序在
    `checkout-options.ts`。
  - 重送同一份表單不會重複建單(`requestId`)。
  - migrations 搬到 `schema.ts`,內容不變。
  - 購物車與結帳頁說明文字提高對比至 WCAG AA;加入購物車按鈕加上 `aria-live`。
- **0.1.0**:首版。
