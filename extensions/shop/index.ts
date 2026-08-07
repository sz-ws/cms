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
  markOrderPaid,
  parseShippingConfig,
} from "@/ext/commerce-kit";
import { ShopShippingPage } from "./admin-shipping";
import { ShopPromosPage } from "./admin-promos";
import { ShopOrdersPage } from "./admin-orders";
import { ShopVerifyPage } from "./admin-verify";
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
  version: "0.1.0",
  // ^1.31.0:宣告了 agentTools(1.30.0 的新表面),而那批 tool 的 write 動詞用了
  // 1.31.0 的 AgentTool.summarize(確認卡的中文摘要)。舊 core 會安靜地忽略這兩個
  // 欄位 —— agentTools 整個不見、摘要退回英文,兩者都沒有錯誤訊息,所以版號要標到
  // 實際用到的那一版。
  coreApi: "^1.31.0",
  description:
    "購物車、結帳與訂單管理:讀取 catalog 商品、透過 payment capability 收款(刷卡/匯款)、匯款人工對帳。",
  icon: "shopping-cart",
  settings: [
    {
      key: "cardProvider",
      label: "刷卡 provider",
      description:
        "gateway payment provider id(如 newebpay,需先安裝該 extension)。留空 = 結帳頁不出現刷卡。",
      type: "text",
      default: "",
    },
    {
      key: "transferProvider",
      label: "匯款 provider",
      description:
        "manual payment provider id。留空 = 結帳頁不出現匯款。",
      type: "text",
      default: "banktransfer",
    },
  ],
  migrations: [
    {
      id: "0001_orders",
      sql: `
        CREATE TABLE IF NOT EXISTS ext_shop_orders (
          order_no TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending_payment',
          lines TEXT NOT NULL,
          subtotal INTEGER NOT NULL,
          discount INTEGER NOT NULL DEFAULT 0,
          shipping INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL,
          payment_provider TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          customer_email TEXT NOT NULL,
          customer_phone TEXT,
          ship_address TEXT,
          transfer_last5 TEXT,
          transfer_reported_at INTEGER,
          note TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_shop_orders_created
          ON ext_shop_orders (created_at);
        CREATE INDEX IF NOT EXISTS idx_ext_shop_orders_status
          ON ext_shop_orders (status, created_at)
      `,
    },
    {
      // Phase 3–4:運費(訂單快照欄)+ 優惠碼表。migration id append-only ——
      // 0001 已在外面跑過就不能改,新欄位一律走 ALTER。
      id: "0002_shipping_promos",
      sql: `
        ALTER TABLE ext_shop_orders ADD COLUMN region TEXT;
        ALTER TABLE ext_shop_orders ADD COLUMN shipping_method TEXT;
        ALTER TABLE ext_shop_orders ADD COLUMN promo_code TEXT;
        CREATE TABLE IF NOT EXISTS ext_shop_promos (
          code TEXT PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL,
          value INTEGER NOT NULL DEFAULT 0,
          min_subtotal INTEGER NOT NULL DEFAULT 0,
          max_uses INTEGER,
          used INTEGER NOT NULL DEFAULT 0,
          starts_at INTEGER,
          ends_at INTEGER,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `,
    },
  ],
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
  ],
  adminPages: [
    { slug: "", title: "訂單", component: ShopOrdersPage },
    { slug: "verify", title: "對帳佇列", component: ShopVerifyPage },
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
      handler: createShippingConfigHandler({ settingsKey: SHIPPING_KEY }),
    },
    {
      method: "POST",
      path: "promos/save",
      handler: createPromoSaveHandler({ table: PROMOS_TABLE }),
    },
    {
      method: "POST",
      path: "promos/delete",
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
      handler: createTransferVerifyHandler({
        table: ORDERS_TABLE,
        resolveTransferProvider: (ctx) => resolveProvider(ctx, "transfer"),
      }),
    },
    {
      method: "POST",
      path: "orders/:orderNo/status",
      handler: createOrderStatusHandler({ table: ORDERS_TABLE }),
    },
  ],
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
