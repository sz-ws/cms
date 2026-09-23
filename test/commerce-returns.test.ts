import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// commerce-kit 1.50.0 退貨引擎的 binding-backed 測試:狀態機、可退件數(含同時建立)、
// 放回庫存與狀態變更同一個 batch(只放回訂單扣走的)、建議金額與退款上限、搜尋。
//
// 退貨表用商店 0004_returns 的真 migration;訂單表用本檔自己的鏡像(DB 跨測試檔共用)。
// 庫存用 ledger-kit 組一個和庫存插件同形狀的 provider(RestockProvider),core 不依賴插件。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { commitLedgerOperations, createLedgerProvider, ledgerAdjustmentSchema, ledgerSchema } from "../src/ext/ledger-kit";
import type { LedgerAccount } from "../src/ext/ledger-kit";
import { ledgerTables } from "../src/ext/ledger-kit/schema";
import {
  RETURN_STATUSES,
  RETURN_TRANSITIONS,
  ReturnError,
  orderReturnBlock,
  orderShipping,
  orderStockReservationId,
  refundCap,
  refundCapShipping,
  suggestedRefund,
  type RestockProvider,
  type ReturnStatus,
} from "../src/ext/commerce-kit/returns";
import { createReturnsEngine } from "../src/ext/commerce-kit/returns-engine";
import { RETURN_ACTIONS } from "../src/ext/commerce-kit/returns-ui";
import { shopMigrations } from "../extensions/shop/schema";

const d1 = () => (env as { DB: D1Database }).DB;
const ORDERS = "ext_rettest_orders";
const PREFIX = "ext_shop_return";
const STOCK = "ext_rettest_stock";
const CONFIG = { ordersTable: ORDERS, prefix: PREFIX };
const actor = { id: "u-admin", name: "店長" };

const item = (sku: string): LedgerAccount => ({ id: sku, owner: { type: "sku", id: sku }, unit: "item", precision: 0 });
function stockProvider(): RestockProvider {
  const ledger = createLedgerProvider(d1(), STOCK);
  return {
    prepareRestock: (sku, qty) => ledger.prepareCredit(item(sku), String(qty)),
    getBalance: (sku) => ledger.getBalance(item(sku)),
    getReservation: (sku, reservationId) => ledger.getReservation(item(sku), reservationId),
  };
}
const available = async (sku: string) => (await stockProvider().getBalance(sku))?.available ?? null;
let opened = 0;
async function openStock(sku: string, qty: number) {
  const ledger = createLedgerProvider(d1(), STOCK);
  await commitLedgerOperations({ id: `open:${sku}:${++opened}`, actor: { type: "user", id: "t" }, reason: "seed" }, [ledger.prepareOpen(item(sku))]);
  await commitLedgerOperations({ id: `seed:${sku}:${++opened}`, actor: { type: "user", id: "t" }, reason: "seed" }, [ledger.prepareCredit(item(sku), String(qty))]);
}
/** 訂單從庫存扣貨(接管訂單的插件下單預留、收款扣下)。 */
async function takeStock(orderNo: string, sku: string, qty: number) {
  const ledger = createLedgerProvider(d1(), STOCK);
  const id = orderStockReservationId(orderNo, sku);
  const actor = { type: "user", id: "t" };
  await commitLedgerOperations({ id: `reserve:${id}`, actor, reason: "order" }, [ledger.prepareReserve(item(sku), id, String(qty), { type: "NORMAL_ORDER", id: orderNo })]);
  await commitLedgerOperations({ id: `capture:${id}`, actor, reason: "paid" }, [ledger.prepareCapture(item(sku), id)]);
}

const LINES = [
  { productId: "p1", name: "商品一", unitPrice: 300, qty: 2 },
  { productId: "p2", name: "商品二", unitPrice: 150, qty: 1 },
];

async function seedOrder(orderNo: string, status = "completed", total = 750, amounts: { subtotal?: number; discount?: number; shipping?: number } = {}) {
  const now = Date.now();
  await d1()
    .prepare(
      `INSERT INTO ${ORDERS} (order_no, status, lines, subtotal, discount, shipping, total, payment_provider, customer_name, customer_email, customer_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'banktransfer', '王小明', 'ming@example.com', '0912-345-678', ?, ?)`,
    )
    .bind(orderNo, status, JSON.stringify(LINES), amounts.subtotal ?? total, amounts.discount ?? 0, amounts.shipping ?? 0, total, now, now)
    .run();
}

const engine = (stock: RestockProvider | null = null) => createReturnsEngine(d1(), CONFIG, stock);

async function expectError(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ReturnError);
  expect((error as ReturnError).code).toBe(code);
  if (status) expect((error as ReturnError).status).toBe(status);
}

async function run(statements: string) {
  for (const sql of statements.split(";").map((s) => s.trim()).filter(Boolean)) await d1().prepare(sql).run();
}

beforeAll(async () => {
  await run(shopMigrations.find((m) => m.id === "0004_returns")!.sql);
  await run(
    `CREATE TABLE IF NOT EXISTS ${ORDERS} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL, lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  await run(`${ledgerSchema(STOCK, { adjustments: false })};${ledgerAdjustmentSchema(STOCK)}`);
});

beforeEach(async () => {
  const t = ledgerTables(STOCK);
  await run(
    [
      `DELETE FROM ${ORDERS}`,
      `DELETE FROM ${PREFIX}_requests`,
      `DELETE FROM ${PREFIX}_events`,
      `DELETE FROM ${PREFIX}_operations`,
      `DELETE FROM ${t.ledger}`,
      `DELETE FROM ${t.reservations}`,
      `DELETE FROM ${t.operations}`,
      `DELETE FROM ${t.accounts}`,
    ].join(";"),
  );
});

const create = (orderNo: string, lines: { productId: string; qty: number }[], requestedAmount = 300, stock: RestockProvider | null = null) =>
  engine(stock).create(actor, { orderNo, lines, reason: "defective", requestedAmount, note: "外盒破損" });

describe("狀態機", () => {
  it("終態不再外流,轉移圖沒有迴圈(退貨編號 + 狀態 = 每一步的冪等鍵)", () => {
    for (const s of ["rejected", "completed", "cancelled"] as ReturnStatus[]) expect(RETURN_TRANSITIONS[s]).toEqual([]);
    const visit = (s: ReturnStatus, path: ReturnStatus[]): void => {
      expect(path).not.toContain(s);
      for (const next of RETURN_TRANSITIONS[s]) visit(next, [...path, s]);
    };
    visit("requested", []);
  });

  it("後台的「下一步」選項和轉移表一致", () => {
    for (const s of RETURN_STATUSES) {
      expect(RETURN_ACTIONS[s].map((a) => a.to).sort()).toEqual([...RETURN_TRANSITIONS[s]].sort());
    }
  });
});

describe("建立退貨", () => {
  it("快照訂單的品項與客人,狀態是申請中,留下建立紀錄", async () => {
    await seedOrder("SO1");
    const r = await create("SO1", [{ productId: "p1", qty: 1 }]);
    expect(r).toMatchObject({
      orderNo: "SO1",
      status: "requested",
      lines: [{ productId: "p1", name: "商品一", unitPrice: 300, qty: 1, restocked: 0 }],
      reason: "defective",
      note: "外盒破損",
      requestedAmount: 300,
      refund: null,
      customerName: "王小明",
      customerPhone: "0912-345-678",
      createdBy: "u-admin",
    });
    expect(r.returnNo).toMatch(/^RT[A-Z0-9]+$/);
    const events = await engine().events(r.returnNo);
    expect(events).toEqual([expect.objectContaining({ action: "created", actorName: "店長", note: "外盒破損" })]);
  });

  it("查無訂單、還沒出貨、已取消、超過可退件數、金額超過退回商品都擋下", async () => {
    await expectError(create("NOPE", [{ productId: "p1", qty: 1 }]), "order_not_found", 404);
    await seedOrder("SO2", "paid");
    await expectError(create("SO2", [{ productId: "p1", qty: 1 }]), "order_not_returnable", 409);
    await seedOrder("SO2C", "cancelled");
    await expectError(create("SO2C", [{ productId: "p1", qty: 1 }]), "order_closed", 409);
    await seedOrder("SO3", "shipped");
    await expectError(create("SO3", [{ productId: "p1", qty: 3 }]), "qty_exceeds", 409);
    await expectError(create("SO3", [{ productId: "zz", qty: 1 }]), "invalid_input", 400);
    await expectError(create("SO3", [{ productId: "p1", qty: 1 }], 301), "amount_exceeds", 409);
    expect(await engine().list()).toEqual([]);
  });

  it("可退件數跨退貨共用;拒絕與取消的退貨把件數還回來", async () => {
    await seedOrder("SO4");
    const first = await create("SO4", [{ productId: "p1", qty: 1 }]);
    await create("SO4", [{ productId: "p1", qty: 1 }]);
    await expectError(create("SO4", [{ productId: "p1", qty: 1 }]), "qty_exceeds");
    expect((await engine().lookupOrder("SO4"))?.lines.find((l) => l.productId === "p1")?.returnable).toBe(0);
    await engine().transition(actor, first.returnNo, { to: "rejected", note: "超過鑑賞期" });
    expect((await engine().lookupOrder("SO4"))?.lines.find((l) => l.productId === "p1")?.returnable).toBe(1);
    await create("SO4", [{ productId: "p1", qty: 1 }]);
  });

  it("商品都退完的訂單:fullyReturned 列出它,再建立退貨被擋下;拒絕的退貨不算", async () => {
    await seedOrder("SO17");
    await seedOrder("SO18");
    const first = await create("SO17", [{ productId: "p1", qty: 2 }]);
    expect(await engine().fullyReturned(["SO17", "SO18"])).toEqual([]);
    await create("SO17", [{ productId: "p2", qty: 1 }], 150);
    expect(await engine().fullyReturned(["SO17", "SO18", "NOPE"])).toEqual(["SO17"]);
    await expectError(create("SO17", [{ productId: "p2", qty: 1 }], 0), "qty_exceeds", 409);
    await engine().transition(actor, first.returnNo, { to: "rejected" });
    expect(await engine().fullyReturned(["SO17"])).toEqual([]);
    await create("SO17", [{ productId: "p1", qty: 2 }]);
    // 一頁訂單有 100 筆以上也查得動(訂單編號是一個 JSON 參數,不是一個編號一個參數)。
    expect(await engine().fullyReturned([...Array.from({ length: 150 }, (_, i) => `X${i}`), "SO17"])).toEqual(["SO17"]);
    expect(await engine().fullyReturned([])).toEqual([]);
  });

  it("兩筆同時搶最後一件:batch 內再算一次,只有一筆成立", async () => {
    await seedOrder("SO5");
    await create("SO5", [{ productId: "p1", qty: 1 }]);
    const results = await Promise.allSettled([
      create("SO5", [{ productId: "p1", qty: 1 }]),
      create("SO5", [{ productId: "p1", qty: 1 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReturnError);
    expect((await engine().list()).length).toBe(2);
  });
});

describe("處理退貨", () => {
  it("完整走一遍:同意 → 收到並放回庫存 → 登記退款 → 結案,每一步都有紀錄", async () => {
    await seedOrder("SO6");
    await openStock("p1", 10);
    await openStock("p2", 5);
    await takeStock("SO6", "p1", 2);
    await takeStock("SO6", "p2", 1);
    const stock = stockProvider();
    expect(await engine(stock).stockFor("SO6", ["p1", "p2"])).toEqual({
      enabled: true,
      tracked: { p1: true, p2: true },
      taken: { p1: true, p2: true },
    });
    const r = await create("SO6", [{ productId: "p1", qty: 2 }, { productId: "p2", qty: 1 }], 750, stock);
    await engine(stock).transition(actor, r.returnNo, { to: "approved" });
    const received = await engine(stock).transition(actor, r.returnNo, {
      to: "received",
      restock: [{ productId: "p1", qty: 2 }, { productId: "p2", qty: 0 }],
      note: "商品二破損",
    });
    expect(received.status).toBe("received");
    expect(received.lines.map((l) => [l.productId, l.restocked])).toEqual([["p1", 2], ["p2", 0]]);
    expect(await available("p1")).toBe("10");
    expect(await available("p2")).toBe("4");

    const refunded = await engine(stock).transition(actor, r.returnNo, {
      to: "refunded",
      refund: { amount: 600, method: "transfer", note: "末五碼 12345" },
    });
    expect(refunded.refund).toMatchObject({ amount: 600, method: "transfer", note: "末五碼 12345" });
    await engine(stock).transition(actor, r.returnNo, { to: "completed" });

    const events = await engine().events(r.returnNo);
    expect(events.map((e) => e.action)).toEqual(["created", "approved", "received", "refunded", "completed"]);
    expect(events[2]).toMatchObject({ note: "商品二破損", restocked: [{ name: "商品一", qty: 2 }] });
    expect(events[3]).toMatchObject({ note: "末五碼 12345", refund: { amount: 600, method: "transfer" } });
  });

  it("不合法的一步擋下;同一步再按一次當成已完成", async () => {
    await seedOrder("SO7");
    const r = await create("SO7", [{ productId: "p1", qty: 1 }]);
    await expectError(engine().transition(actor, r.returnNo, { to: "received" }), "illegal_transition", 409);
    await engine().transition(actor, r.returnNo, { to: "approved" });
    const again = await engine().transition(actor, r.returnNo, { to: "approved" });
    expect(again.status).toBe("approved");
    expect((await engine().events(r.returnNo)).filter((e) => e.action === "approved")).toHaveLength(1);
    await expectError(engine().transition(actor, "RTNOPE", { to: "approved" }), "not_found", 404);
  });

  it("沒有庫存 provider:收到退貨只記錄;要放回庫存會說庫存沒啟用", async () => {
    await seedOrder("SO8");
    const r = await create("SO8", [{ productId: "p1", qty: 1 }]);
    await engine().transition(actor, r.returnNo, { to: "approved" });
    await expectError(
      engine().transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p1", qty: 1 }] }),
      "stock_unavailable",
    );
    const received = await engine().transition(actor, r.returnNo, { to: "received" });
    expect(received.status).toBe("received");
    expect(received.lines[0].restocked).toBe(0);
  });

  it("沒有庫存帳的商品不能放回(不會憑空開始管它的庫存)", async () => {
    await seedOrder("SO9");
    await openStock("p1", 1);
    const stock = stockProvider();
    const r = await create("SO9", [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }]);
    await engine(stock).transition(actor, r.returnNo, { to: "approved" });
    await expectError(
      engine(stock).transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }] }),
      "stock_untracked",
    );
    expect(await available("p1")).toBe("1");
    expect(await stockProvider().getBalance("p2")).toBeNull();
    expect((await engine().get(r.returnNo))?.status).toBe("approved");
  });

  it("放回庫存和狀態變更同一個 batch:狀態被別人改掉時,庫存也不動", async () => {
    await seedOrder("SO10");
    await openStock("p1", 4);
    await takeStock("SO10", "p1", 2);
    const r = await create("SO10", [{ productId: "p1", qty: 2 }]);
    await engine().transition(actor, r.returnNo, { to: "approved" });
    // 引擎讀完狀態、送出 batch 前,另一個人把退貨取消了。
    const base = stockProvider();
    const racing: RestockProvider = {
      prepareRestock: base.prepareRestock,
      getReservation: base.getReservation,
      getBalance: async (sku) => {
        await d1().prepare(`UPDATE ${PREFIX}_requests SET status = 'cancelled' WHERE return_no = ?`).bind(r.returnNo).run();
        return base.getBalance(sku);
      },
    };
    await expectError(
      engine(racing).transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p1", qty: 2 }] }),
      "changed",
      409,
    );
    expect(await available("p1")).toBe("2");
    const after = await engine().get(r.returnNo);
    expect(after?.status).toBe("cancelled");
    expect(after?.lines[0].restocked).toBe(0);
    expect((await engine().events(r.returnNo)).map((e) => e.action)).toEqual(["created", "approved"]);
  });

  it("這張訂單沒從庫存扣過的不能放回(舊結帳、啟用庫存前的訂單):不會憑空多出庫存", async () => {
    await seedOrder("SO14");
    await openStock("p1", 3);
    await openStock("p2", 3);
    await takeStock("SO14", "p2", 1);
    // 別張訂單扣走 p1,不算這張的。
    await takeStock("OTHER", "p1", 1);
    const stock = stockProvider();
    const r = await create("SO14", [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }]);
    await engine(stock).transition(actor, r.returnNo, { to: "approved" });
    expect((await engine(stock).stockFor("SO14", ["p1", "p2"])).taken).toEqual({ p1: false, p2: true });
    await expectError(
      engine(stock).transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }] }),
      "stock_not_taken",
      409,
    );
    expect(await available("p1")).toBe("2");
    expect((await engine().get(r.returnNo))?.status).toBe("approved");
    const received = await engine(stock).transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p2", qty: 1 }] });
    expect(received.lines.map((l) => [l.productId, l.restocked])).toEqual([["p1", 0], ["p2", 1]]);
    expect(await available("p2")).toBe("3");
  });

  it("放回庫存的件數不能超過退貨件數", async () => {
    await seedOrder("SO11");
    await openStock("p1", 1);
    const stock = stockProvider();
    const r = await create("SO11", [{ productId: "p1", qty: 1 }]);
    await engine(stock).transition(actor, r.returnNo, { to: "approved" });
    await expectError(
      engine(stock).transition(actor, r.returnNo, { to: "received", restock: [{ productId: "p1", qty: 2 }] }),
      "invalid_input",
      400,
    );
    expect(await available("p1")).toBe("1");
  });
});

describe("退款", () => {
  it("同意後可以直接退款(不收回商品);同一張訂單的退款合計不超過訂單金額", async () => {
    await seedOrder("SO12", "completed", 500);
    const a = await create("SO12", [{ productId: "p1", qty: 1 }], 300);
    const b = await create("SO12", [{ productId: "p1", qty: 1 }], 300);
    for (const r of [a, b]) await engine().transition(actor, r.returnNo, { to: "approved" });
    await engine().transition(actor, a.returnNo, { to: "refunded", refund: { amount: 300, method: "original" } });
    await expectError(
      engine().transition(actor, b.returnNo, { to: "refunded", refund: { amount: 201, method: "cash" } }),
      "amount_exceeds",
      409,
    );
    const ok = await engine().transition(actor, b.returnNo, { to: "refunded", refund: { amount: 200, method: "cash" } });
    expect(ok.refund?.amount).toBe(200);
    expect((await engine().lookupOrder("SO12"))?.refunded).toBe(500);
  });

  it("建議金額扣掉訂單折扣、不含運費,不超過還沒退的金額;申請金額也不能超過", async () => {
    // 商品 750、優惠折 150、運費 100 → 實付 700;每一元商品實付 0.8 元。
    await seedOrder("SO15", "completed", 700, { subtotal: 750, discount: 150, shipping: 100 });
    const order = (await engine().lookupOrder("SO15"))!;
    expect(order).toMatchObject({ subtotal: 750, discount: 150, total: 700, refunded: 0 });
    expect(suggestedRefund(order, [{ unitPrice: 300, qty: 1 }])).toBe(240);
    expect(suggestedRefund(order, [{ unitPrice: 300, qty: 2 }, { unitPrice: 150, qty: 1 }])).toBe(600);
    expect(suggestedRefund(order, [])).toBe(0);

    const a = await create("SO15", [{ productId: "p1", qty: 2 }], 480);
    await engine().transition(actor, a.returnNo, { to: "approved" });
    // 退款最多到這兩件的商品金額 600 加運費 100,這裡剛好是整張訂單的 700。
    await expectError(
      engine().transition(actor, a.returnNo, { to: "refunded", refund: { amount: 701, method: "transfer" } }),
      "amount_exceeds",
      409,
    );
    await engine().transition(actor, a.returnNo, { to: "refunded", refund: { amount: 600, method: "transfer" } });
    const after = (await engine().lookupOrder("SO15"))!;
    // 只剩 100 可退:商品二實付 120、加運費上限 250,建議金額與申請金額都以 100 為上限。
    expect(suggestedRefund(after, [{ unitPrice: 150, qty: 1 }])).toBe(100);
    await expectError(create("SO15", [{ productId: "p2", qty: 1 }], 101), "amount_exceeds", 409);
    expect((await create("SO15", [{ productId: "p2", qty: 1 }], 100)).requestedAmount).toBe(100);
  });

  it("上限是退回商品加運費:從運費 150 的訂單退一件 150 元的商品,最多 300、建議 150", async () => {
    // 商品 750、運費 150 → 訂單 900。
    await seedOrder("SO16", "completed", 900, { subtotal: 750, shipping: 150 });
    const order = (await engine().lookupOrder("SO16"))!;
    const one = [{ unitPrice: 150, qty: 1 }];
    expect(orderShipping(order)).toBe(150);
    expect(refundCap(order, one)).toBe(300);
    expect(refundCapShipping(order, one)).toBe(150);
    expect(suggestedRefund(order, one)).toBe(150);
    expect(refundCap(order, [{ unitPrice: 300, qty: 2 }, { unitPrice: 150, qty: 1 }])).toBe(900);
    // 上限不超過訂單還沒退的金額;剩下的不夠時,提示裡的運費跟著縮。
    expect(refundCap({ ...order, refunded: 800 }, one)).toBe(100);
    expect(refundCapShipping({ ...order, refunded: 800 }, one)).toBe(0);
    expect(refundCapShipping({ ...order, refunded: 650 }, one)).toBe(100);
    // 折扣吃掉的部分不算運費:商品 750、折 150、運費 100 → 訂單 700,運費 100。
    expect(orderShipping({ subtotal: 750, discount: 150, total: 700 })).toBe(100);
    expect(orderShipping({ subtotal: 750, discount: 0, total: 750 })).toBe(0);

    await expectError(create("SO16", [{ productId: "p2", qty: 1 }], 301), "amount_exceeds", 409);
    const r = await create("SO16", [{ productId: "p2", qty: 1 }], 150);
    await engine().transition(actor, r.returnNo, { to: "approved" });
    await expectError(
      engine().transition(actor, r.returnNo, { to: "refunded", refund: { amount: 301, method: "cash" } }),
      "amount_exceeds",
      409,
    );
    const refunded = await engine().transition(actor, r.returnNo, { to: "refunded", refund: { amount: 300, method: "cash" } });
    expect(refunded.refund?.amount).toBe(300);

    // 下一筆退貨:商品 600 + 運費 150 = 750,但訂單只剩 600 可退。
    await expectError(create("SO16", [{ productId: "p1", qty: 2 }], 601), "amount_exceeds", 409);
    const rest = await create("SO16", [{ productId: "p1", qty: 2 }], 600);
    await engine().transition(actor, rest.returnNo, { to: "approved" });
    await expectError(
      engine().transition(actor, rest.returnNo, { to: "refunded", refund: { amount: 601, method: "cash" } }),
      "amount_exceeds",
      409,
    );
    await engine().transition(actor, rest.returnNo, { to: "refunded", refund: { amount: 600, method: "cash" } });
    expect((await engine().lookupOrder("SO16"))?.refunded).toBe(900);
  });

  it("訂單不能退貨的原因:還沒出貨 vs 已取消、已退款", () => {
    expect(orderReturnBlock("shipped")).toBeNull();
    expect(orderReturnBlock("completed")).toBeNull();
    for (const s of ["pending_payment", "awaiting_verify", "paid"] as const) expect(orderReturnBlock(s)).toBe("order_not_returnable");
    for (const s of ["cancelled", "refunded"] as const) expect(orderReturnBlock(s)).toBe("order_closed");
  });

  it("退款要有金額與方式", async () => {
    await seedOrder("SO13");
    const r = await create("SO13", [{ productId: "p1", qty: 1 }]);
    await engine().transition(actor, r.returnNo, { to: "approved" });
    await expectError(engine().transition(actor, r.returnNo, { to: "refunded" }), "invalid_input", 400);
    await expectError(
      engine().transition(actor, r.returnNo, { to: "refunded", refund: { amount: 0, method: "cash" } }),
      "invalid_input",
    );
  });
});

describe("列表與搜尋", () => {
  it("狀態篩選、搜尋訂單編號與電話、各狀態筆數", async () => {
    await seedOrder("SOA1");
    await seedOrder("SOB2");
    const a = await create("SOA1", [{ productId: "p1", qty: 1 }]);
    await create("SOB2", [{ productId: "p2", qty: 1 }], 150);
    await engine().transition(actor, a.returnNo, { to: "approved" });

    expect((await engine().list({ status: "approved" })).map((r) => r.returnNo)).toEqual([a.returnNo]);
    expect((await engine().list({ search: { q: "SOB2" } })).map((r) => r.orderNo)).toEqual(["SOB2"]);
    expect(await engine().list({ search: { q: "0912345" } })).toHaveLength(2);
    expect(await engine().list({ search: { q: "王小明" } })).toHaveLength(2);
    expect(await engine().counts()).toEqual({ approved: 1, requested: 1 });
    // 有搜尋條件時,各狀態筆數只算符合的(和列表一致)。
    expect(await engine().counts({ q: "SOB2" })).toEqual({ requested: 1 });
  });
});
