# shop — 商店(commerce-kit 接線層)

購物車、結帳、訂單管理。引擎在 `src/ext/commerce-kit/`(訂單狀態機、伺服器計價、
匯款對帳流程、admin 積木),本資料夾只有接線:表名、settings、route 宣告、
admin 頁組裝、`payment:succeeded` 綁定。設計說明見 `docs/spec-commerce-kit.md`。

## 需要的東西

- **商品**:declarative `catalog` extension(`catalog.product`,含 `name` + `price`)。
- **收款**(payment capability,至少一種):
  - 匯款:`extensions/banktransfer`(manual provider,人工對帳)。
  - 刷卡:任一 gateway provider(如 `extensions/newebpay`),
    設定 `ext.shop.cardProvider` 指向其 providerId。

## 安裝

不預裝(同 newebpay)。`extensions/registry.ts` 加:

```ts
import { shop } from "./shop";
import { banktransfer } from "./banktransfer";
// registry 陣列加入 shop, banktransfer
```

rebuild + deploy 後在 `/admin/extensions` 啟用,到設定頁填銀行帳戶。

## 動線

```
訪客:catalog 商品頁(AddToCartButton)→ /shop/cart → /shop/checkout
  刷卡:form-post/redirect 跳轉 gateway → 回呼 → 訂單 paid
  匯款:出示帳號(kind:"manual")→ 客人回報末五碼 → 訂單 awaiting_verify
店家:/admin/ext/shop(訂單)· /admin/ext/shop/verify(對帳佇列)
  核可 → settleManual → payment:succeeded → 訂單 paid → 出貨 → 完成
```

台灣無 open banking,到帳與否只有店家的銀行看得到 —— 所以匯款的狀態切換是
**人工一級公民**,兩條路並存:客人回報末五碼(→ 待對帳),或 admin 在對帳佇列
「等待匯款(未回報)」區/訂單列直接**標記已收款**,不必等客人回報。

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

## 客製店面前端(這是預期行為)

店面 UI **刻意全部住在本資料夾**,而引擎(狀態機/計價/對帳/API)在
`src/ext/commerce-kit/` —— 邊界就是「引擎不改、外觀隨便改」:

- `CartView.tsx` / `CheckoutView.tsx` / `AddToCartButton.tsx`:逐站直接改
  (extensions/ 本來就是 per-site 版控的檔案,同 registry.ts 的定位)。
- `cart-store.ts` 是資料層(subscribe/snapshot/addToCart/setQty/clearCart),
  自訂 UI 只管消費它,不必自己碰 localStorage。
- 換整頁版面 = 改 `public-pages.tsx` 的殼,或整組換掉 publicRoutes 的 component。
- 結帳協定不變即可:POST `/api/ext/shop/checkout`(items+聯絡資料+method)、
  POST `/api/ext/shop/transfer-report`(orderNo+last5);session 三種 kind 的
  處理見 CheckoutView(form-post 自動送出 / redirect / manual 指示)。

## 商品頁掛加入購物車鈕

`AddToCartButton` 是 client 元件,配 catalog 的 progressive 強化層使用
(照 `extensions/gallery-enhance/` 的 override 模式,對
`public:catalog.product:detail` 註冊自訂 detail,內嵌
`<AddToCartButton productId={entry.id} name={…} unitPrice={…} />`)。

## 刻意不做(v1)

- 伺服器端購物車(localStorage 就夠;結帳時伺服器重新計價,永不信 client)。
- 庫存(無限賣;要做時加獨立 stock 表,不動訂單表)。
- 團購 / 推薦佣金(Phase 5–6):插槽已規格化,見 `docs/spec-commerce-kit.md`
  §7(meta 快照欄 + `commerce:order:created` hook + reprice 計價攔截;
  migration id 0003 已保留)。落地時照規格 drop-in,不動現有結帳路徑。
- 訂單查詢頁(客人關頁後補回報:記訂單編號即可,回 /shop/checkout 不行 ——
  follow-up 再做 lookup)。
