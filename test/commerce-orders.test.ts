import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// commerce-kit 訂單狀態機的 binding-backed 測試:轉移表反查 + 條件式 UPDATE
// (race-safe / 冪等)、匯款回報欄位、markOrderPaid hook 監聽器。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { db } from "../src/lib/db";
import {
  countByStatus,
  createOrder,
  getOrder,
  listOrders,
  markOrderPaid,
  transitionOrder,
} from "../src/ext/commerce-kit/orders";
import { ORDER_TRANSITIONS, transitionSources } from "../src/ext/commerce-kit/types";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const TABLE = "ext_shoptest_orders";
const deps = () => ({ db: db() });

const LINES = [{ productId: "p1", name: "商品一", unitPrice: 300, qty: 2 }];
const AMOUNTS = { subtotal: 600, discount: 0, shipping: 0, total: 600 };

async function seed(orderNo: string, status = "pending_payment") {
  await createOrder(deps(), TABLE, {
    orderNo,
    lines: LINES,
    amounts: AMOUNTS,
    paymentProvider: "banktransfer",
    customerName: "王小明",
    customerEmail: "ming@example.com",
  });
  if (status !== "pending_payment") {
    await d1()
      .prepare(`UPDATE ${TABLE} SET status = ? WHERE order_no = ?`)
      .bind(status, orderNo)
      .run();
  }
}

beforeAll(async () => {
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec(`DELETE FROM ${TABLE};`);
});

describe("狀態機定義", () => {
  it("transitionSources 由 ORDER_TRANSITIONS 反查(單一事實來源)", () => {
    expect(transitionSources("paid").sort()).toEqual([
      "awaiting_verify",
      "pending_payment",
    ]);
    expect(transitionSources("completed")).toEqual(["shipped"]);
    expect(transitionSources("cancelled").sort()).toEqual([
      "awaiting_verify",
      "pending_payment",
    ]);
    // 終態不再外流
    expect(ORDER_TRANSITIONS.completed).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
  });
});

describe("createOrder / getOrder", () => {
  it("建單後可讀回快照(lines JSON + 金額拆帳)", async () => {
    await seed("CO1");
    const order = await getOrder(deps(), TABLE, "CO1");
    expect(order).toMatchObject({
      orderNo: "CO1",
      status: "pending_payment",
      lines: LINES,
      amounts: AMOUNTS,
      paymentProvider: "banktransfer",
      customerName: "王小明",
      transferLast5: null,
    });
  });
});

describe("transitionOrder", () => {
  it("合法路徑:pending_payment → awaiting_verify(帶回報欄位)→ paid → shipped → completed", async () => {
    await seed("CO2");
    expect(
      await transitionOrder(deps(), TABLE, "CO2", "awaiting_verify", {
        transferLast5: "12345",
        transferReportedAt: 1234,
      }),
    ).toBe(true);
    const reported = await getOrder(deps(), TABLE, "CO2");
    expect(reported?.status).toBe("awaiting_verify");
    expect(reported?.transferLast5).toBe("12345");
    expect(reported?.transferReportedAt).toBe(1234);

    expect(await transitionOrder(deps(), TABLE, "CO2", "paid")).toBe(true);
    expect(await transitionOrder(deps(), TABLE, "CO2", "shipped")).toBe(true);
    expect(await transitionOrder(deps(), TABLE, "CO2", "completed")).toBe(true);
    expect((await getOrder(deps(), TABLE, "CO2"))?.status).toBe("completed");
  });

  it("非法轉移拒絕:pending_payment → shipped、completed → paid、重複 paid", async () => {
    await seed("CO3");
    expect(await transitionOrder(deps(), TABLE, "CO3", "shipped")).toBe(false);

    await seed("CO4", "completed");
    expect(await transitionOrder(deps(), TABLE, "CO4", "paid")).toBe(false);

    await seed("CO5", "paid");
    expect(await transitionOrder(deps(), TABLE, "CO5", "paid")).toBe(false); // 冪等
    expect((await getOrder(deps(), TABLE, "CO5"))?.status).toBe("paid");
  });

  it("查無此單 → false", async () => {
    expect(await transitionOrder(deps(), TABLE, "NOPE", "paid")).toBe(false);
  });
});

describe("markOrderPaid(payment:succeeded 監聽器)", () => {
  it("pending_payment 與 awaiting_verify 都翻成 paid(刷卡/匯款同構)", async () => {
    await seed("CO6");
    await markOrderPaid(deps(), TABLE, { providerId: "x", orderNo: "CO6" });
    expect((await getOrder(deps(), TABLE, "CO6"))?.status).toBe("paid");

    await seed("CO7", "awaiting_verify");
    await markOrderPaid(deps(), TABLE, { providerId: "x", orderNo: "CO7" });
    expect((await getOrder(deps(), TABLE, "CO7"))?.status).toBe("paid");
  });

  it("查無此單 / payload 無 orderNo → 靜默略過(admin 測試付款不炸)", async () => {
    await markOrderPaid(deps(), TABLE, { providerId: "x", orderNo: "GHOST" });
    await markOrderPaid(deps(), TABLE, { providerId: "x", event: {} });
    await markOrderPaid(deps(), TABLE, null);
    // 出貨後的重複回呼不得倒退
    await seed("CO8", "shipped");
    await markOrderPaid(deps(), TABLE, { providerId: "x", orderNo: "CO8" });
    expect((await getOrder(deps(), TABLE, "CO8"))?.status).toBe("shipped");
  });
});

describe("listOrders / countByStatus", () => {
  it("狀態 filter 與計數", async () => {
    await seed("CO9");
    await seed("CO10", "paid");
    await seed("CO11", "paid");
    const paid = await listOrders(deps(), TABLE, { status: "paid" });
    expect(paid.map((o) => o.orderNo).sort()).toEqual(["CO10", "CO11"]);
    expect(await countByStatus(deps(), TABLE)).toEqual({
      pending_payment: 1,
      paid: 2,
    });
  });
});
