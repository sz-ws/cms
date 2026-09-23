import { shopMigrations } from "./schema";
import { recentPurchases } from "./public-feeds";
import { SHOP_CHECKOUT_SETTINGS } from "./checkout-options";
import { defineExtension } from "@/ext/types";
import type { ApiCtx } from "@/ext/types";
import { db } from "@/lib/db";
import {
  createCommerceAgentTools,
  createCommerceCheckoutHandler,
  createOrderStatusHandler,
  createPromoDeleteHandler,
  createPromoQuoteHandler,
  createPromoSaveHandler,
  createShippingConfigHandler,
  createTransferReportHandler,
  createTransferVerifyHandler,
  createReturnsApiRoutes,
  markOrderPaid,
  CATALOG_SETTINGS,
  ORDER_SEARCH_FIELDS,
  RETURN_STATUS_SET,
  parseShippingConfig,
} from "@/ext/commerce-kit";
import { ShopShippingPage } from "./admin-shipping";
import { ShopPromosPage } from "./admin-promos";
import { ShopOrdersPage } from "./admin-orders";
import { ShopVerifyPage } from "./admin-verify";
import { ShopReturnsPage } from "./admin-returns";
import { SHOP_RETURNS, SHOP_RETURNS_SEARCH } from "./returns-config";
import { ShopCartPage, ShopCheckoutPage } from "./public-pages";

// 商店 extension —— commerce-kit 的薄接線層(引擎全部來自 @/ext/commerce-kit,
// 這裡只有:表名、settings、route 宣告、admin 頁組裝、payment:succeeded 綁定)。
//
// 商品來源:declarative `catalog` extension 的 `catalog.product`(name + price),
// 結帳時伺服器重新讀價,永不信 client。購物車在瀏覽器 localStorage(cart-store.ts)
// —— 車只是結帳前的暫存 UI 狀態,訂單才是事實;等做棄單行銷再上桌。
//
// 收款走 payment capability:
//   - 刷卡:settings.cardProvider 指向任一 gateway provider(如 "newebpay",
//     需另行安裝該 extension)。
//   - 匯款:settings.transferProvider 指向 manual provider(預設 "banktransfer")。
//     客人回報末五碼 → 訂單進 awaiting_verify → admin 對帳佇列核可 →
//     settleManual → payment:succeeded → 訂單 paid。
// 兩條路對訂單而言完全同構 —— 都只靠下方那一個 hook。
//
// 受管訂單(0.2.0):裝了 shop-operations(私有插件)並啟用,commerce-kit 的結帳
// handler 會把整筆結帳交給它的 `commerce:orders` provider(原子庫存、會員查單、
// 對帳、推薦佣金)。shop 這邊不做判斷、沒有開關 —— 結帳頁只依插件啟用狀態切換
// 表單(需登入、電話與地址必填、推薦碼欄位)。三個結帳頁開關在 checkout-options.ts。
//
// 退貨(0.6.0):已出貨、已完成的訂單可以建立退貨(店家代客人建立)→ 同意/拒絕 →
// 收到退貨(裝了庫存插件時可放回庫存,和狀態同一個 batch)→ 登記退款 → 結案。引擎在
// commerce-kit/returns-engine.ts;退款只記錄,錢要店家自己在金流或銀行退。退貨是訂單旁的
// 獨立紀錄,不改訂單狀態,所以受管訂單(shop-operations)也適用。
//
// 不預裝(newebpay 前例):要用的站自行加進 extensions/registry.ts。

const ORDERS_TABLE = "ext_shop_orders";
const PROMOS_TABLE = "ext_shop_promos";
const SHIPPING_KEY = "ext.shop.shippingConfig";
// ScopedSettings 收**完整** key(ext.<extId>.<key>)—— 只給區域名會 throw。
const CARD_PROVIDER_KEY = "ext.shop.cardProvider";
// 兩個消費者:核帳 route(經 ctx.services.settings)與 agent 的核可 tool(kit 自建
// scoped settings)。同一個常數 = 不可能分家。
const TRANSFER_PROVIDER_KEY = "ext.shop.transferProvider";

async function resolveProvider(
  ctx: ApiCtx,
  method: "card" | "transfer",
): Promise<string> {
  const key = method === "card" ? CARD_PROVIDER_KEY : TRANSFER_PROVIDER_KEY;
  return (await ctx.services.settings.get<string>(key, "")).trim();
}

export const shop = defineExtension({
  id: "shop",
  name: "商店",
  version: "0.7.0",
  // ^1.31.0:宣告了 agentTools(1.30.0 的新表面),而那批 tool 的 write 動詞用了
  // 1.31.0 的 AgentTool.summarize(確認卡的中文摘要)。舊 core 會安靜地忽略這兩個
  // 欄位 —— agentTools 整個不見、摘要退回英文,兩者都沒有錯誤訊息,所以版號要標到
  // 實際用到的那一版。
  //
  // ^1.40.0:訂單頁宣告搜尋(頂欄搜尋框、⌘K 找訂單)。
  //
  // ^1.48.0:publicFeeds(給宣告式插件 script 的公開資料)。
  //
  // ^1.49.0:商品目錄併進 commerce-kit,開關(ext.shop.catalog)在這裡的設定。
  //
  // ^1.50.0:退貨(commerce-kit 的退貨引擎、API、後台頁與 returns 狀態組);
  // 各 API 以 accessAs 跟著對應後台頁的角色權限。
  //
  // ^1.52.0(0.7.0):commerce-kit 的唯讀模式(運費、優惠碼、對帳佇列)與訂單列表的
  // loadFullyReturned / returned。
  coreApi: "^1.52.0",
  description:
    "商品目錄、購物車、結帳、訂單與退貨管理：刷卡或匯款收款，匯款由後台人工對帳。",
  icon: "shopping-cart",
  // 1.39.0:側欄「商務」一區;付款方式(banktransfer、newebpay)掛在這個資料夾底下。
  menu: { section: "commerce", order: 20 },
  settings: [
    // 0.5.0:商品目錄開關。定義在 commerce-kit(商店啟用且這個沒關,商品目錄才啟用)。
    ...CATALOG_SETTINGS,
    {
      key: "cardProvider",
      label: "信用卡付款",
      description: "輸入插件代號，例如 newebpay。不提供刷卡就留空。",
      type: "text",
      default: "",
    },
    {
      key: "transferProvider",
      label: "匯款付款",
      description: "輸入插件代號，預設是 banktransfer（銀行轉帳）。不提供匯款就留空。",
      type: "text",
      default: "banktransfer",
    },
    // 結帳頁開關(推薦碼欄位、電話地址必填、結帳頁說明);定義與說明見
    // checkout-options.ts,README「設定」一節有整表。
    ...SHOP_CHECKOUT_SETTINGS,
  ],
  migrations: shopMigrations,
  uninstall: [
    {
      id: "0001_drop_orders",
      sql: `
        DROP INDEX IF EXISTS idx_ext_shop_orders_status;
        DROP INDEX IF EXISTS idx_ext_shop_orders_created;
        DROP TABLE IF EXISTS ext_shop_orders
      `,
    },
    {
      id: "0002_drop_promos",
      sql: `DROP TABLE IF EXISTS ext_shop_promos`,
    },
    {
      // 退貨跟著訂單走:訂單表都刪了,退貨與它的交易收據留著也對不回任何訂單。
      // 放回庫存的流水帳在庫存插件的表裡,不受影響。
      id: "0004_drop_returns",
      sql: `
        DROP INDEX IF EXISTS idx_ext_shop_return_events_return;
        DROP INDEX IF EXISTS idx_ext_shop_return_requests_order;
        DROP INDEX IF EXISTS idx_ext_shop_return_requests_status;
        DROP INDEX IF EXISTS idx_ext_shop_return_requests_created;
        DROP TABLE IF EXISTS ext_shop_return_events;
        DROP TABLE IF EXISTS ext_shop_return_requests;
        DROP TABLE IF EXISTS ext_shop_return_operations
      `,
    },
  ],
  adminPages: [
    {
      slug: "",
      title: "訂單",
      component: ShopOrdersPage,
      // 1.40.0:頂欄搜尋框(名字、電話、Email、訂單編號、下單期間),⌘K 也找得到訂單。
      search: {
        placeholder: "姓名、電話、Email 或訂單編號",
        fields: ORDER_SEARCH_FIELDS,
        global: {
          id: "orders",
          label: "訂單",
          table: ORDERS_TABLE,
          key: "order_no",
          title: "customer_name",
          subtitle: ["order_no", "customer_phone"],
        },
      },
    },
    { slug: "verify", title: "對帳佇列", component: ShopVerifyPage },
    {
      // 0.6.0:退貨管理。頂欄搜尋與 ⌘K 的宣告在 returns-config.ts。
      slug: "returns",
      title: { en: "Returns", "zh-Hant": "退貨管理" },
      component: ShopReturnsPage,
      search: SHOP_RETURNS_SEARCH,
    },
    { slug: "shipping", title: "運費", component: ShopShippingPage },
    { slug: "promos", title: "優惠碼", component: ShopPromosPage },
  ],
  apiRoutes: [
    {
      method: "POST",
      path: "checkout",
      public: true, // 訪客就是呼叫者;rate limit 在 handler 內(commerce-kit)
      handler: createCommerceCheckoutHandler({
        table: ORDERS_TABLE,
        resolveProvider,
        promoTable: PROMOS_TABLE,
        resolveShippingConfig: async (ctx) =>
          parseShippingConfig(await ctx.services.settings.get<string>(SHIPPING_KEY, "")),
      }),
    },
    {
      method: "POST",
      path: "promo-quote",
      public: true, // 結帳頁預覽折扣;rate limit 在 handler 內
      handler: createPromoQuoteHandler({ table: PROMOS_TABLE }),
    },
    {
      method: "POST",
      path: "shipping-config",
      accessAs: "shop/shipping", // 1.50.0:角色與權限跟著運費頁
      handler: createShippingConfigHandler({ settingsKey: SHIPPING_KEY }),
    },
    {
      method: "POST",
      path: "promos/save",
      accessAs: "shop/promos",
      handler: createPromoSaveHandler({ table: PROMOS_TABLE }),
    },
    {
      method: "POST",
      path: "promos/delete",
      accessAs: "shop/promos",
      handler: createPromoDeleteHandler({ table: PROMOS_TABLE }),
    },
    {
      method: "POST",
      path: "transfer-report",
      public: true,
      handler: createTransferReportHandler({ table: ORDERS_TABLE }),
    },
    {
      method: "POST",
      path: "orders/:orderNo/verify",
      accessAs: "shop/verify",
      handler: createTransferVerifyHandler({
        table: ORDERS_TABLE,
        resolveTransferProvider: (ctx) => resolveProvider(ctx, "transfer"),
      }),
    },
    {
      method: "POST",
      path: "orders/:orderNo/status",
      accessAs: "shop",
      handler: createOrderStatusHandler({ table: ORDERS_TABLE }),
    },
    // 0.6.0:退貨(returns/…,只給 admin;路由表在 commerce-kit/returns-api.ts)。
    // 角色與權限跟著退貨管理頁。
    ...createReturnsApiRoutes(SHOP_RETURNS).map((route) => ({ ...route, accessAs: "shop/returns" })),
  ],
  // 0.6.0:退貨狀態組 shop:returns(站台可用 filter:statusSets 改名)。
  statusSets: [RETURN_STATUS_SET],
  publicRoutes: [
    {
      // /shop/cart
      match: (s) => (s.length === 2 && s[0] === "shop" && s[1] === "cart" ? {} : null),
      component: ShopCartPage,
    },
    {
      // /shop/checkout
      match: (s) =>
        s.length === 2 && s[0] === "shop" && s[1] === "checkout" ? {} : null,
      component: ShopCheckoutPage,
    },
  ],
  // docs/spec-admin-agent.md §2:admin agent 的訂單動作。引擎在 kit(名字、schema、
  // 描述、核可路徑全在 commerce-kit/agent-tools.ts),這裡照舊只給表名與 settings key。
  // 裝了這個 extension,後台的 AI 面板就會多出 shop.orders.* 四個 tool —— core 一行
  // 都不必改,兩個 write 一律走確認卡(kind:"write",spec §1.2)。
  // 1.48.0:最近成交(只有商品名、件數、時間),宣告式插件以
  // {{feed.shop.recentPurchases}} 取用,見 ./public-feeds.ts。
  publicFeeds: { recentPurchases },
  agentTools: createCommerceAgentTools({
    extId: "shop",
    table: ORDERS_TABLE,
    transferProviderKey: TRANSFER_PROVIDER_KEY,
  }),
  hooks: {
    // 唯一把訂單翻成 paid 的地方 —— 刷卡回呼與匯款核帳都經 payment-kit 的統一
    // 結算觸發這個 hook(payload 自 1.28.0 起帶 orderNo)。查無此單(如 admin
    // 測試付款)靜默略過。commerce-kit 只需要 db(CommerceDb),@/lib/db 直取
    // —— 不走 @/ext/services,那會經 loader 形成 registry → shop → services →
    // loader → registry 的 module-eval 循環。
    "payment:succeeded": async (payload: unknown) => {
      await markOrderPaid({ db: db() }, ORDERS_TABLE, payload);
    },
  },
});
