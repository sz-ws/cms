# shop — 商店(commerce-kit 接線層)

購物車、結帳、訂單管理。引擎在 `src/ext/commerce-kit/`(訂單狀態機、伺服器計價、
匯款對帳流程、admin 積木),本資料夾只有接線:表名、settings、route 宣告、
admin 頁組裝、`payment:succeeded` 綁定。設計說明見 `docs/spec-commerce-kit.md`。

## 需要的東西

- **商品**:commerce-kit 內建的商品目錄(`catalog.product`,含 `name` + `price`;分類
  `catalog.category`)。core 1.49.0 起商店啟用就有,不用另外安裝;設定 `catalog` 關掉會
  收起商品目錄,資料保留。
- **收款**(payment capability,至少一種):
  - 匯款:`extensions/banktransfer`(manual provider,人工對帳)。
  - 刷卡:任一 gateway provider(如 `extensions/newebpay`),
    設定 `ext.shop.cardProvider` 指向其 providerId。
- **選配**:`shop-operations`(私有插件,需 core 1.37)—— 裝了並啟用,結帳改走
  受管訂單,見下方「商城營運模式」。

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

| key | 類型 | 預設 | 作用 | 生效範圍 |
|---|---|---|---|---|
| `catalog` | boolean | `true` | 商品目錄(後台商品、分類頁與前台 `/products`)。`false` = 收起來,商品與分類保留;定義在 `commerce-kit/catalog.ts`。 | 兩種模式 |
| `cardProvider` | text | `""` | 刷卡的 gateway provider id(如 `newebpay`)。空 = 結帳頁不出現刷卡。 | 兩種模式 |
| `transferProvider` | text | `banktransfer` | 匯款的 manual provider id。空 = 結帳頁不出現匯款。 | 兩種模式 |
| `shippingConfig` | (JSON) | `""` | 由 `/admin/ext/shop/shipping` 頁維護,不在設定頁手填。空 = 不啟用運費。 | 兩種模式 |
| `referralMode` | select | `field` | 推薦碼欄位:`field` 顯示欄位(推薦連結帶入的碼會先填好)、`link` 不顯示欄位但仍送出推薦連結帶入的碼、`off` 完全不用。 | 只在商城營運模式;舊結帳一律視為 `off` |
| `requireContact` | boolean | `false` | 電話與收件地址必填(表單層)。 | 只影響舊結帳;商城營運模式一律必填 |
| `checkoutNotice` | textarea | `""` | 結帳頁最上方的說明文字,保留換行。空 = 不顯示。 | 兩種模式 |

三個結帳頁開關的讀取順序:`public-pages.tsx` 在伺服器讀出原始值 →
`resolveCheckoutOptions()` 正規化(壞值退回預設,絕不擋結帳)→ 交給 `CheckoutView`。
`CheckoutView` 對 props 再跑一次同一個函式,所以自訂殼層少給幾個 prop 也會得到一致
的預設。優先序(由 `test/shop-checkout-options.test.ts` 鎖住):

- 非商城營運模式:`referralMode` 一律 `off`、`signedIn` 一律 false;`requireContact`
  照設定。
- 商城營運模式:`requireContact` 一律 true(伺服器 schema 要求);`referralMode`
  照設定,不合法的值退回 `field`。

**沒有「是否委派給商城營運」的開關**,理由見下一節。

## 動線

```
訪客:catalog 商品頁(AddToCartButton)→ /shop/cart → /shop/checkout
  刷卡:form-post/redirect 跳轉 gateway → 回呼 → 訂單 paid
  匯款:出示帳號(kind:"manual")→ 客人回報末五碼 → 訂單 awaiting_verify
店家:/admin/ext/shop(訂單)· /admin/ext/shop/verify(對帳佇列)
  核可 → settleManual → payment:succeeded → 訂單 paid → 出貨 → 完成
商城營運模式:同一條路,但結帳與訂單狀態由 shop-operations 接手(見下節)
```

台灣無 open banking,到帳與否只有店家的銀行看得到 —— 所以匯款的狀態切換是
**人工一級公民**,兩條路並存:客人回報末五碼(→ 待對帳),或 admin 在對帳佇列
「等待匯款(未回報)」區/訂單列直接**標記已收款**,不必等客人回報。

## 商城營運模式(shop-operations 啟用時)

### 什麼時候算啟用、誰在委派

`shop-operations` 註冊一個 `commerce:orders` provider(id = `ext_shop_orders`)。
commerce-kit 的結帳 handler(`createCommerceCheckoutHandler`)每次都先問 providers
registry 有沒有這個 provider:

- **有** → 整筆結帳交給它(`managed.checkout`):伺服器定價、共用庫存預留、優惠碼
  核銷、推薦歸因、訂單與受管標記一次原子提交,付款 session 用同一單號建立。
- **沒有,但 D1 已有受管標記表 `ext_shop_orders_managed`**(曾經啟用過、現在停用)
  → 回 `503 {"ok":false,"error":"商城營運插件未啟用，暫停結帳"}`。**不會**退回舊結帳:
  既有受管訂單若用舊路徑改狀態,庫存與佣金就會對不上(`commerce-kit/managed.ts`)。
- **沒有,也沒有標記表** → 0.1.0 的舊結帳,行為完全不變。

訂單狀態轉移(`/api/ext/shop/orders/:orderNo/status`、對帳核可、admin agent 的
`shop.orders.*` tool)同樣先看該單有沒有受管標記,有就交給 provider 的 `transition`。

shop 這邊只做一件事:`public-pages.tsx` 用 `getExtRuntime().byId("shop-operations")`
看插件是否啟用,決定結帳頁長哪個樣子。**所以沒有 shop 端的開關** —— 若加一個
「關閉委派」,頁面會顯示舊表單、伺服器仍走受管結帳,兩邊對不上。要退出商城營運
模式,唯一正確的動作是在 `/admin/extensions` 停用 shop-operations(它有
`canDisable` 守門:尚有未完成訂單或待退款項時拒絕停用),停用後結帳會停在上面的
503 直到重新啟用或另行處理受管訂單。

### 結帳頁的差異

| | 舊結帳(0.1.0 行為) | 商城營運模式 |
|---|---|---|
| 身分 | 訪客,免登入 | 需登入(guest 以上);未登入頂端顯示「請先登入會員後結帳」與登入連結(`/login?next=/shop/checkout`),送出會被伺服器 401 |
| 電話、收件地址 | 選填(`requireContact` 可改必填) | 必填 |
| 推薦碼 | 無 | 依 `referralMode`:欄位 / 只用連結 / 不用 |
| 「我的訂單」連結 | 無 | 有(`/shop/orders`,shop-operations 的公開頁) |
| 匯款成立後的說明 | 「請於三日內匯款」 | 「請依「我的訂單」顯示的付款期限付款」(期限 = shop-operations 的 `holdMinutes`,逾期自動取消並放回庫存) |
| 匯款末五碼回報 | `POST /api/ext/shop/transfer-report` | `POST /api/ext/shop-operations/actions`,body 加 `action:"report"` |

### 結帳協定的差異

同一個端點 `POST /api/ext/shop/checkout`,body 多兩個欄位、幾個限制不同:

| 欄位 | 舊結帳 | 商城營運模式 |
|---|---|---|
| `requestId` | 不收 | **必填**,UUID。同一份表單重送用同一個 id → 不重複建單、不重複扣庫存(換內容才換 id,`CheckoutView` 以表單指紋維護) |
| `referralCode` | 不收 | 選填,`^[A-Z0-9_-]{3,30}$`;`CheckoutView` 一律轉大寫 |
| `items` | 1–50 項,qty 1–99 | 1–12 項,qty 1–99 |
| `name` | 1–100 字 | 1–300 字 |
| `phone` | 選填,≤30 | 必填,1–30 |
| `address` | 選填,≤200 | 必填,1–300 |
| `shippingMethodId` | 選填 | 必填;店家必須先在 /admin/ext/shop/shipping 設好配送方式,否則結帳回 503「請先設定配送方式與運費」(`CheckoutView` 在沒有選項時送空字串,讓伺服器回這句而不是籠統的格式錯誤) |
| `promoCode` | ≤60 | ≤40 |
| rate limit | 每 IP 15 分鐘 20 次 | 每登入者每分鐘 20 次 |
| body 大小 | 無額外上限 | 24 KB |

### 錯誤碼

`CheckoutView` 把 `error` 對成中文(`ERROR_HINT`);對不到的原樣顯示為「結帳失敗:…」。
舊結帳回英文代碼,商城營運模式的業務錯誤直接回中文句子。

舊結帳(commerce-kit `checkout.ts`):

| `error` | 狀態碼 | 說明 |
|---|---|---|
| `invalid_input` | 400 | 欄位缺漏或格式不對 |
| `unknown_product` / `unpriced_product` | 422 | 商品下架或沒有價格(帶 `productId`) |
| `invalid_shipping` / `promo_invalid` / `method_not_enabled` / `invalid_total` | 422 | 配送、優惠碼(帶 `reason`)、付款方式、金額不成立 |
| `not_configured` 等 session 錯誤 | 422 | 付款 provider 建立 session 失敗,body 即 session(`ok:false`) |
| `not_available` | 503 | 付款 provider 不在 registry |
| `rate_limited` | 429 | 每 IP 15 分鐘 20 次 |

商城營運模式(shop-operations `api.ts` / `engine.ts`):

| `error` | 狀態碼 | 說明 |
|---|---|---|
| (401 auth body) | 401 | 未登入;`requireAuth("guest")` |
| `invalid_input` | 400 / 413 | body 不是 JSON 物件 / 超過 24 KB |
| `資料不完整或格式不正確` | 400 | zod 驗證失敗(含缺 `requestId`、電話或地址) |
| `referral_invalid` / `referral_self` | 400 | 推薦碼不存在或已停用 / 推薦者不能拿自己訂單的佣金 |
| `rate_limited` | 429 | 每登入者每分鐘 20 次 |
| `商品已下架`、`配送方式不適用`、`優惠碼不適用`、`訂單金額超出範圍` | 422 | 伺服器重算後不成立 |
| `請求編號已用於其他內容` | 409 | 同一 `requestId` 換了內容或換了人 |
| `商品庫存或訂單狀態已改變，請重新確認` | 409 | 原子提交被 ledger 前置條件擋下(庫存不足、搶最後一個名額) |
| `請先設定配送方式與運費`、`請先啟用庫存、配送與推薦插件`、`付款插件須支援訂單狀態查詢` | 503 | 店家或站台設定未完成 |
| session 錯誤(如 `not_configured`) | 422 | 付款 provider 建立 session 失敗 |
| `操作未完成，請重新整理後確認` | 500 | 未預期錯誤,伺服器端有 log |

kit 層(兩種模式都可能遇到):`商城營運插件未啟用，暫停結帳`(503,見「什麼時候算啟用」)。

推薦碼被拒時 `CheckoutView` 會把瀏覽器記住的推薦連結(`localStorage`
`shop.referral.v1`,由 shop-operations 的 `/products?ref=` 寫入、30 天)一併清掉:
`referralMode` 為 `field` 時保留欄位內容讓客人自己移除;為 `link` 時沒有欄位可移除,
直接清空並請客人再送出一次(新的 `requestId`)。

### 訂單狀態操作分工

受管訂單一律由 provider 執行,shop 的舊路由只剩「轉交」或「拒絕」兩種結果:

| 動作 | 舊結帳 | 商城營運模式 |
|---|---|---|
| 客人回報末五碼 | `POST /api/ext/shop/transfer-report` | `POST /api/ext/shop-operations/actions`(`action:"report"`);舊端點對受管訂單回 409「請登入會員訂單中心回報匯款」 |
| 標記已收款(paid) | shop 對帳佇列核可 → `settleManual` | shop-operations 的每分鐘對帳排程(比對付款 provider 的持久化紀錄),或 `/admin/ext/shop-operations` 核實付款;shop 對帳佇列對受管訂單回 409「請至商城營運處理此訂單」 |
| 出貨(shipped)、退款(refunded) | shop 訂單頁 | **只能**在 `/admin/ext/shop-operations` 填物流或退款憑證;shop 訂單頁與 agent tool 會收到「請至商城營運填寫物流或退款憑證」 |
| 完成(completed)、取消(cancelled) | shop 訂單頁 | shop 訂單頁可用(需 admin)並轉交 provider:取消會放回庫存、退回佣金、還原優惠碼用量;完成會確認佣金 |

### 停用與卸載

- core 不讓你在 shop-operations 啟用中停用 shop(`requiresExtensions` 反查,
  `src/ext/code-lifecycle.ts`):會得到「尚有啟用中的插件依賴此插件」。順序永遠是
  先停用 shop-operations(它自己還有 `canDisable` 守門),再停用 shop。
- shop 的 `uninstall` 只丟 `ext_shop_orders`、`ext_shop_promos` 與三張退貨表
  (`ext_shop_return_*`;放回庫存的流水帳在庫存插件的表裡,不受影響);受管標記表與事件表
  屬於 shop-operations(`canUninstall: false`,保留金融歷史),所以裝過 shop-operations
  的站實際上也不該卸載 shop。

## 運費與優惠碼(Phase 3–4)

- **運費**:/admin/ext/shop/shipping 設定配送方式 + 規則(滿額免運、離島加收…,
  順序即優先序),右欄即時試算。設定存 `ext.shop.shippingConfig`;沒設定 =
  不啟用運費(數位商品/自取直接留空)。結帳頁把所有方式算好列給客人挑。
- **優惠碼**:/admin/ext/shop/promos 建碼(打折 % / 折抵 / 免運 + 低消 + 次數
  上限)。結帳頁輸入後即時預覽,送單時伺服器原子核銷 —— 搶最後一次用量
  只有一單成立。
- 金額拆帳:`subtotal − discount + shipping = total`,全部伺服器算,快照入單。

訂單狀態機(`commerce-kit/types.ts` 唯一定義):
`pending_payment → (awaiting_verify ⇄) → paid → shipped → completed`,
另 `cancelled`(收款前)與 `refunded`(記帳用;gateway 退款 API 刻意不做)。

## 退貨(0.6.0)

後台 `/admin/ext/shop/returns`「退貨管理」。已出貨、已完成的訂單才能退貨;還沒出貨的訂單
走取消(舊結帳在訂單頁,商城營運模式在它的訂單管理)。店家代客人建立,客人自己申請的
表單還沒有。

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
  受管訂單因此也適用,不必繞過 shop-operations 的狀態規則。
- **處理紀錄**:建立與每一步都記下誰、什麼時候、備註(`ext_shop_return_events`,
  人名當下存一份)。
- **放回庫存**:啟用了提供 `inventory` capability(provider id `inventory`)的庫存插件時,
  「收到退貨」時勾「放回庫存」再逐項填件數(預設不放回:收回來的不一定能再賣),和狀態
  變更同一個 D1 batch(ledger-kit)。只放回這張訂單真的從庫存扣走的:訂單的預留
  `<訂單編號>:<商品 id>`(`orderStockReservationId`)要是已扣下(captured)。舊結帳的
  訂單、啟用庫存前的訂單沒有扣過庫存,不給放回(放回去會憑空多出庫存)。沒有庫存帳的
  商品不能放回(不會憑空開始管它的庫存)。沒裝庫存插件就只記錄。
- **退款只記錄**:金額、方式(原付款方式退回、銀行轉帳、現金、其他)、備註。CMS 不會把錢
  退回金流或銀行,畫面上照實寫;同一張訂單的退款合計不超過訂單金額。建立退貨時的預設
  金額是退回件數的實付價格(按訂單折扣比例折算,不含運費)。申請金額與實際退款的上限
  都是退回這幾件的商品金額(單價 × 件數)加上這張訂單的運費(`refundCap`;運費 =
  訂單金額 −(商品金額 − 折扣),`orderShipping`),也不超過訂單還沒退的金額:從運費 150
  的訂單退一件 150 元的商品,最多退 300,不是整張訂單的金額。整張退、或瑕疵品由店家負擔
  運費時,可以把預設金額改成連運費一起退。
- **權限**:API 只給 admin(`returns/…`,見 `commerce-kit/returns-api.ts`);後台頁本來就
  只開給 admin。
- **搜尋**:頂欄可找退貨編號、訂單編號、姓名、電話與建立期間;⌘K 也找得到。狀態名稱在
  狀態組 `shop:returns`,站台可用 `filter:statusSets` 改名。
- **從訂單開退貨**:訂單列表(或商城營運的訂單明細)的「申請退貨」帶著訂單編號打開
  「新增退貨」(`?order=`)。

表(migration `0004_returns`):`ext_shop_return_requests`(退貨)、`ext_shop_return_events`
(處理紀錄)、`ext_shop_return_operations`(ledger-kit 交易收據)。

### 升級到 0.6.0

部署後到「擴充功能」按商店的「套用更新」,`0004_returns` 才會建表;在那之前退貨頁會請你
先套用,API 回 503 `not_ready`。

## 客製店面前端(這是預期行為)

店面 UI **刻意全部住在本資料夾**,而引擎(狀態機/計價/對帳/API)在
`src/ext/commerce-kit/` —— 邊界就是「引擎不改、外觀隨便改」:

- `CartView.tsx` / `CheckoutView.tsx` / `AddToCartButton.tsx`:逐站直接改
  (extensions/ 本來就是 per-site 版控的檔案,同 registry.ts 的定位)。
- `cart-store.ts` 是資料層(subscribe/snapshot/addToCart/setQty/clearCart),
  自訂 UI 只管消費它,不必自己碰 localStorage。
- `checkout-options.ts` 是開關層:設定定義 + `resolveCheckoutOptions()`,沒有 React,
  自訂殼層直接沿用即可拿到相同的預設與優先序。
- 換整頁版面 = 改 `public-pages.tsx` 的殼,或整組換掉 publicRoutes 的 component。
- `CheckoutView` 的 props:`cardEnabled`、`transferEnabled`(必填);`shippingConfig`、
  `promoEnabled`、`managedOrders`、`signedIn`、`referralMode`、`requireContact`、
  `notice`(選填,預設同 `resolveCheckoutOptions`)。
- 結帳協定不變即可:POST `/api/ext/shop/checkout`(items+聯絡資料+method;商城營運
  模式另加 requestId 與 referralCode,見上節)、匯款回報依模式打不同端點;session
  三種 kind 的處理見 CheckoutView(form-post 自動送出 / redirect / manual 指示)。

## 商品頁掛加入購物車鈕

`AddToCartButton` 是 client 元件,給站台自己的商品頁使用
(照 `extensions/gallery-enhance/` 的 override 模式,對
`public:catalog.product:detail` 註冊自訂 detail,內嵌
`<AddToCartButton productId={entry.id} name={…} unitPrice={…} />`)。

## 刻意不做

- 伺服器端購物車(localStorage 就夠;結帳時伺服器重新計價,永不信 client)。
- 庫存與推薦佣金**不在 shop 裡做**:由 shop-operations + inventory + referral 提供
  (見「商城營運模式」);`docs/spec-commerce-kit.md` §7 原本規劃的 meta 欄、
  `commerce:order:created` hook 與佣金表都沒有建立,migration id 0003 仍保留未用
  (退貨用的是 0004)。
- 團購(§7.2)未動。
- 訂單查詢頁:舊結帳沒有(客人記訂單編號即可);商城營運模式由 `/shop/orders` 提供。

## 從 0.1.0 升級

- **沒有新的 migration**:0001、0002 不變(只是搬到 `schema.ts`),`uninstall` 不變。
- **新設定都有預設值**,不填也能跑;預設值下舊結帳的行為與 0.1.0 完全相同。
- **coreApi 仍是 `^1.31.0`**:shop 自己只多用了 `getExtRuntime().byId` 與
  `getSessionUser`,兩者自首版就有。委派本身是 core 1.37 的行為,由 shop-operations
  (`coreApi ^1.37.0`)帶進來;較舊的 core 裝不了它,shop 就維持 0.1.0 的樣子。
- **自訂過 `CheckoutView` 的站**:合併時注意 props 多了 `managedOrders`、`signedIn`、
  `referralMode`、`requireContact`、`notice`,送單 body 多了 `requestId`/`referralCode`,
  匯款回報端點依模式切換。沒改過的站照常覆蓋。
- 新增檔案:`schema.ts`、`checkout-options.ts`;新增測試:
  `test/shop-checkout-options.test.ts`、`test/shop-checkout-view.test.tsx`。

## 版本

- **0.6.0**:需要 core 1.50.0。退貨管理(見「退貨」一節):migration `0004_returns`、後台頁
  `returns`、狀態組 `shop:returns`、四個 admin API(`returns/…`);訂單列表的已出貨、已完成
  訂單多一個「申請退貨」。要按「套用更新」才會建表。
- **0.5.0**:需要 core 1.49.0。商品目錄併進 commerce-kit:商店啟用就有商品與分類
  (`catalog.product`、`catalog.category`),不再從 registry 安裝。新設定 `catalog` 可以關掉它。
  已從 registry 裝過商品目錄的站,第一次載入時由底座接手,商品、分類與設定都不動。
- **0.4.0**:需要 core 1.48.0。提供公開 feed `recentPurchases`(最近 20 筆已付款、已出貨、
  已完成的訂單,每筆只有第一個品項名稱、其他品項數、下單時間),宣告式插件的 script 以
  `{{feed.shop.recentPurchases}}` 取用,例如購買通知浮層。姓名、聯絡方式、地址、金額都不會出去。
- **0.3.0**:需要 core 1.40.0。訂單頁宣告搜尋:頂欄可用姓名、電話(忽略空白與
  連字號)、Email 或訂單編號找訂單,並篩選下單期間;狀態篩選保留搜尋條件。⌘K 全站
  搜尋也找得到訂單。頁面標題跟著側欄名稱(站台改名後一致)。
- **0.2.2**:設定頁的收款欄位改名為「信用卡付款」「匯款付款」,說明改寫成白話。
- **0.2.1**:後台側欄收在「商務」一區,訂單、對帳佇列、運費、優惠碼合成一個「商店」
  資料夾;銀行轉帳與藍新金流啟用時也掛在同一個資料夾底下。需要 core 1.39.0 才會
  分區與收合,較舊的 core 照舊平鋪。
- **0.2.0**
  - 啟用 `shop-operations` 時結帳改由受管訂單處理(原子庫存、會員查單、對帳、
    推薦佣金);結帳頁依插件啟用狀態切換:需登入、電話與地址必填、推薦碼欄位、
    「我的訂單」連結、匯款回報端點。未安裝時行為不變。
  - 新設定 `referralMode`(推薦碼欄位:顯示 / 只用連結 / 不用)、`requireContact`
    (舊結帳的電話與地址必填)、`checkoutNotice`(結帳頁說明);讀取與優先序在
    `checkout-options.ts`。
  - 推薦碼無法使用時說明原因,並清掉瀏覽器記住的推薦連結;只用連結時自動移除後
    請客人再送出一次。
  - 重送同一份表單不會重複建單(`requestId`)。
  - migrations 搬到 `schema.ts`,內容不變。
  - 購物車與結帳頁說明文字提高對比至 WCAG AA;加入購物車按鈕加上 `aria-live`。
- **0.1.0**:首版。
