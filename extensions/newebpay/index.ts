import { defineExtension } from "@/ext/types";
import {
  createPaymentProvider,
  createCheckoutHandler,
} from "@/ext/payment-kit";
import { createNewebPayAdapter, ORDERS_TABLE } from "./adapter";
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

export const newebpay = defineExtension({
  id: "newebpay",
  name: "藍新金流",
  // 0.2.0:同一張訂單再去付款時換一個送藍新的商店訂單編號(adapter.ts 檔頭),只開信用卡;
  // 後台頁與設定欄位照藍新商店後台的叫法(商店代號、HashKey、HashIV),不寫實作細節。
  // 0.2.1:藍新回呼的 TradeInfo 是 32 bytes 一塊補齊的,WebCrypto 只認 16 bytes 一塊,補了 17–32 個 byte 的那一半
  // 回呼解不開、付款沒記到訂單上(2026-10-21 正式站第一筆就是這樣)。crypto.ts 的 decryptTradeInfo 自己去填充。
  // 0.2.2:藍新說成功之外,還要有付款時間、金額跟訂單一樣才算付清(藍新官方 WooCommerce 外掛也這樣查;adapter.ts 的
  // paidInFull)。對不上時錢可能已經扣了,所以不算失敗:交給 kit 當作結果無法確認(「付款結果確認中」、通知回 500)。
  version: "0.2.2",
  coreApi: "^1.14.0",
  description:
    "線上刷卡收款：客人在藍新付款成功後，訂單會自動改成已付款。",
  icon: "credit-card",
  menu: { section: "commerce", parent: "shop" },
  settings: [
    {
      key: "merchantId",
      label: "商店代號",
      description: "藍新商店後台的商店代號（MS 開頭）。",
      type: "text",
      default: "",
    },
    {
      key: "hashKey",
      label: "HashKey",
      description: "到藍新商店後台的「API 串接金鑰」複製 HashKey（32 碼）。",
      type: "text",
      secret: true, // → ext.newebpay.hashKey,自動走 AES-GCM 加密管線。
      default: "",
    },
    {
      key: "hashIv",
      label: "HashIV",
      description: "同樣在「API 串接金鑰」裡（16 碼）。",
      type: "text",
      secret: true,
      default: "",
    },
    {
      key: "env",
      label: "環境",
      description: "正式收款選正式機。測試機不會真的扣款，要搭配藍新測試平台的商店代號與金鑰。",
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
