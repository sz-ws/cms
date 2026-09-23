import { transactionSchema } from "@/ext/ledger-kit";

/** 0.6.0 退貨表的前綴(0004_returns;commerce-kit 的 returnTables 由它推出表名)。 */
export const SHOP_RETURNS_PREFIX = "ext_shop_return";

export const shopMigrations = [
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
    {
      // 0.6.0:退貨(commerce-kit/returns-engine.ts 的表契約)。退貨列、處理紀錄與放回庫存
      // 經 ledger-kit 同一個 batch 寫入,所以要有自己的交易收據表(transactionSchema)。
      // lines 是 JSON 快照 [{ productId, name, unitPrice, qty, restocked }];金額是整數 TWD。
      // 0003 跳過:docs/spec-commerce-kit.md §7 把它保留給訂單 meta / 團購那批 ALTER。
      id: "0004_returns",
      sql: `
        ${transactionSchema(SHOP_RETURNS_PREFIX)};
        CREATE TABLE IF NOT EXISTS ext_shop_return_requests (
          return_no TEXT PRIMARY KEY,
          order_no TEXT NOT NULL,
          status TEXT NOT NULL,
          lines TEXT NOT NULL,
          reason TEXT NOT NULL,
          note TEXT,
          requested_amount INTEGER NOT NULL,
          refund_amount INTEGER,
          refund_method TEXT,
          refund_note TEXT,
          refunded_at INTEGER,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_shop_return_requests_order
          ON ext_shop_return_requests (order_no);
        CREATE INDEX IF NOT EXISTS idx_ext_shop_return_requests_status
          ON ext_shop_return_requests (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_ext_shop_return_requests_created
          ON ext_shop_return_requests (created_at);
        CREATE TABLE IF NOT EXISTS ext_shop_return_events (
          id TEXT PRIMARY KEY,
          return_no TEXT NOT NULL,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          note TEXT,
          data TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_shop_return_events_return
          ON ext_shop_return_events (return_no, created_at)
      `,
    },
  ];
