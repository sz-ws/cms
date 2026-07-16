import { defineExtension } from "@/ext/types";
import {
  createPaymentProvider,
  createCheckoutHandler,
} from "@/ext/payment-kit";
import { createNewebPayAdapter } from "./adapter";
import { NewebPayAdminPage } from "./admin-page";

// 藍新金流(NewebPay)extension —— capability "payment" 的第一個 provider,
// 也是 payment-kit 模式的參考實作:金流專屬邏輯只有 adapter.ts + crypto.ts,
// 引擎(訂單/回呼結算/結果頁/checkout handler)全部來自 @/ext/payment-kit。
// 接新金流照抄這個資料夾的形狀:換 adapter、換表名、換設定欄位即可。
//
// coreApi "^1.14.0":依賴 PaymentProvider 介面與 CallbackReceiver 的 Response
// 回傳支援(皆 1.14.0 新增,payment-kit 同批)。
//
// 兩個 provides 共用同一個 kit provider,只差 mode:
//   payment/newebpay        → NotifyURL(server-to-server,回 {ok:true})
//   payment/newebpay-return → ReturnURL(使用者瀏覽器,回 HTML 結果頁)
// 藍新對兩個 URL POST 的 payload 格式相同,驗簽邏輯共用。

const ORDERS_TABLE = "ext_newebpay_orders";

export const newebpay = defineExtension({
  id: "newebpay",
  name: "藍新金流",
  version: "0.1.0",
  coreApi: "^1.14.0",
  description:
    "NewebPay MPG 2.0 收款:提供 payment capability(createCheckout)、訂單記錄與付款回呼處理。",
  icon: "credit-card",
  settings: [
    {
      key: "merchantId",
      label: "Merchant ID",
      description: "藍新商店代號(MS 開頭)。",
      type: "text",
      default: "",
    },
    {
      key: "hashKey",
      label: "Hash Key",
      description: "商店後台核發,固定 32 字元。",
      type: "text",
      secret: true, // → ext.newebpay.hashKey,自動走 AES-GCM 加密管線。
      default: "",
    },
    {
      key: "hashIv",
      label: "Hash IV",
      description: "商店後台核發,固定 16 字元。",
      type: "text",
      secret: true,
      default: "",
    },
    {
      key: "env",
      label: "環境",
      description: "測試機(ccore)或正式機(core)。",
      type: "select",
      options: [
        { value: "test", label: "測試機" },
        { value: "prod", label: "正式機" },
      ],
      default: "test",
    },
  ],
  migrations: [
    {
      id: "0001_orders",
      sql: `
        CREATE TABLE IF NOT EXISTS ext_newebpay_orders (
          order_no TEXT PRIMARY KEY,
          amount INTEGER NOT NULL,
          description TEXT NOT NULL,
          email TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          trade_no TEXT,
          payment_type TEXT,
          pay_time TEXT,
          raw_result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_newebpay_orders_created
          ON ext_newebpay_orders (created_at)
      `,
    },
  ],
  uninstall: [
    {
      id: "0001_drop_orders",
      sql: `
        DROP INDEX IF EXISTS idx_ext_newebpay_orders_created;
        DROP TABLE IF EXISTS ext_newebpay_orders
      `,
    },
  ],
  adminPages: [
    {
      slug: "",
      title: "藍新金流",
      component: NewebPayAdminPage,
    },
  ],
  apiRoutes: [
    {
      method: "POST",
      path: "checkout",
      handler: createCheckoutHandler("newebpay"),
    },
  ],
  provides: [
    {
      capability: "payment",
      id: "newebpay",
      create: (services) =>
        createPaymentProvider({
          services,
          adapter: createNewebPayAdapter(services),
          providerId: "newebpay",
          table: ORDERS_TABLE,
          mode: "notify",
        }),
    },
    {
      capability: "payment",
      id: "newebpay-return",
      create: (services) =>
        createPaymentProvider({
          services,
          adapter: createNewebPayAdapter(services),
          providerId: "newebpay",
          table: ORDERS_TABLE,
          mode: "return",
        }),
    },
  ],
});
