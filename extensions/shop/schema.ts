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
  ];
