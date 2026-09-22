import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// shop 0.4.0 的公開 feed:這份資料會嵌進每個公開頁,所以要證明的是「只有成交、
// 只有商品名與時間」,而不只是形狀對。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { recentPurchases, toRecentPurchase } from "../extensions/shop/public-feeds";
import { shopMigrations } from "../extensions/shop/schema";

const d1 = () => (env as { DB: D1Database }).DB;

async function order(orderNo: string, status: string, names: string[], at: number) {
  const lines = JSON.stringify(names.map((name, i) => ({ productId: `p${i}`, name, unitPrice: 140, qty: 1 })));
  await d1()
    .prepare(
      `INSERT INTO ext_shop_orders (order_no, status, lines, subtotal, total, payment_provider,
        customer_name, customer_email, customer_phone, ship_address, created_at, updated_at)
       VALUES (?, ?, ?, 140, 140, 'banktransfer', '王小明', 'ming@example.com', '0912345678', '台北市信義路', ?, ?)`,
    )
    .bind(orderNo, status, lines, at, at)
    .run();
}

beforeAll(async () => {
  const create = shopMigrations[0].sql.split(";").map((s) => s.trim()).filter(Boolean);
  await d1().batch(create.map((sql) => d1().prepare(sql)));
});

beforeEach(async () => {
  await d1().prepare("DELETE FROM ext_shop_orders").run();
});

describe("shop recentPurchases feed", () => {
  it("lists paid, shipped and completed orders, newest first", async () => {
    await order("A", "paid", ["茶葉禮盒"], 1_000);
    await order("B", "shipped", ["陶杯", "杯墊"], 3_000);
    await order("C", "completed", ["帆布袋"], 2_000);
    await order("D", "pending_payment", ["手沖壺"], 4_000);
    await order("E", "cancelled", ["濾紙"], 5_000);
    await order("F", "refunded", ["茶匙"], 6_000);

    expect(await recentPurchases()).toEqual([
      { product: "陶杯", more: 1, at: 3_000 },
      { product: "帆布袋", more: 0, at: 2_000 },
      { product: "茶葉禮盒", more: 0, at: 1_000 },
    ]);
  });

  it("never carries the buyer's details", async () => {
    await order("A", "paid", ["茶葉禮盒"], 1_000);
    const serialized = JSON.stringify(await recentPurchases());
    for (const secret of ["王小明", "ming@example.com", "0912345678", "台北市", "140", "banktransfer"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("skips orders whose lines cannot be read", () => {
    expect(toRecentPurchase({ lines: "not json", created_at: 1 })).toBeNull();
    expect(toRecentPurchase({ lines: "[]", created_at: 1 })).toBeNull();
    expect(toRecentPurchase({ lines: JSON.stringify([{ name: "  " }]), created_at: 1 })).toBeNull();
  });
});
