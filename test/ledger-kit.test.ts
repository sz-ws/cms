import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

vi.mock("@/lib/cf", () => ({ getDB: () => (env as { DB: D1Database }).DB }));

import { commitLedgerOperations, createLedgerProvider, formatUnits, ledgerAdjustmentSchema, ledgerSchema, parseUnits } from "../src/ext/ledger-kit";
import type { LedgerAccount, LedgerCommand, LedgerOperation, LedgerOwner } from "../src/ext/ledger-kit";
import { ledgerTables } from "../src/ext/ledger-kit/schema";

// Two ledgers sharing one D1 binding, composed the way extensions use the kit:
// a 4-decimal credit ledger and an integer per-SKU stock ledger.
const CREDIT_PREFIX = "ext_wallet";
const STOCK_PREFIX = "ext_inventory";
const item = (sku: string): LedgerAccount => ({ id: sku, owner: { type: "sku", id: sku }, unit: "item", precision: 0 });
function quantity(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("quantity must be a positive safe integer");
  return String(value);
}
function createStockLedger(db: D1Database) {
  const ledger = createLedgerProvider(db, STOCK_PREFIX);
  return {
    prepareOpen: (sku: string) => ledger.prepareOpen(item(sku)),
    prepareRestock: (sku: string, qty: number) => ledger.prepareCredit(item(sku), quantity(qty)),
    prepareReserve: (sku: string, reservationId: string, qty: number, source: LedgerOwner) => ledger.prepareReserve(item(sku), reservationId, quantity(qty), source),
    prepareCapture: (sku: string, reservationId: string) => ledger.prepareCapture(item(sku), reservationId),
    prepareRelease: (sku: string, reservationId: string) => ledger.prepareRelease(item(sku), reservationId),
    prepareReturn: (sku: string, reservationId: string) => ledger.prepareRefund(item(sku), reservationId),
    getBalance: (sku: string) => ledger.getBalance(item(sku)),
    getReservation: (sku: string, reservationId: string) => ledger.getReservation(item(sku), reservationId),
  };
}

const d1 = (env as { DB: D1Database }).DB;
const w = createLedgerProvider(d1, CREDIT_PREFIX);
const stock = createStockLedger(d1);
const account: LedgerAccount = { id: "wallet-1", owner: { type: "partner", id: "partner-1" }, unit: "product-credit", precision: 4 };
const source = { type: "order", id: "order-1" };
const command = (id: string): LedgerCommand => ({ id, actor: { type: "user", id: "admin-1" }, reason: "verified operation" });
const commit = (id: string, ...ops: LedgerOperation[]) => commitLedgerOperations(command(id), ops);

beforeAll(async () => {
  // Apply the kit's upgrade path (0001 without adjustments, then 0002) through the
  // same statement splitting the manager uses, rather than a test-only schema.
  for (const prefix of [CREDIT_PREFIX, STOCK_PREFIX]) {
    for (const migration of [ledgerSchema(prefix, { adjustments: false }), ledgerAdjustmentSchema(prefix)]) {
      for (const sql of migration.split(";").map((s) => s.trim()).filter(Boolean)) {
        await d1.prepare(sql).run();
      }
    }
  }
});

beforeEach(async () => {
  for (const prefix of ["ext_wallet", "ext_inventory"]) {
    const t = ledgerTables(prefix);
    for (const table of [t.ledger, t.reservations, t.operations, t.accounts]) {
      await d1.prepare(`DELETE FROM ${table}`).run();
    }
  }
});

async function seed(credit = "10", qty = 10) {
  await commit("seed",
    w.prepareOpen(account), w.prepareCredit(account, credit),
    stock.prepareOpen("sku-1"), stock.prepareRestock("sku-1", qty));
}

async function counts(prefix: string) {
  const t = ledgerTables(prefix);
  const result: Record<string, number> = {};
  for (const [key, table] of Object.entries(t)) {
    result[key] = (await d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  }
  return result;
}

describe("exact fixed-point amounts", () => {
  it.each([
    ["1.4", 4, 14000, "1.4000"], ["0.7", 2, 70, "0.70"], ["0.25", 4, 2500, "0.2500"],
    ["100", 0, 100, "100"], ["0", 4, 0, "0.0000"],
    ["900719925474.0991", 4, Number.MAX_SAFE_INTEGER, "900719925474.0991"],
  ])("converts %s at precision %i exactly", (value, precision, units, formatted) => {
    expect(parseUnits(value, precision)).toBe(units);
    expect(formatUnits(units, precision)).toBe(formatted);
  });

  it.each(["-1", "1e2", "NaN", "Infinity", " 1", "1 ", "01", ".1", "1.", "0.00001", "900719925474.0992", "0x10"])("rejects invalid/unsafe amount %s", (value) => {
    expect(() => parseUnits(value, 4)).toThrow();
  });

  it("rejects unsupported precision, number inputs and fractional stock", () => {
    expect(() => parseUnits("1", 5)).toThrow();
    expect(() => parseUnits("1", 1.5)).toThrow();
    expect(() => parseUnits(1.4 as unknown as string, 4)).toThrow();
    expect(() => w.prepareCredit(account, "0")).toThrow();
    expect(() => stock.prepareRestock("sku-1", 0.5)).toThrow();
    expect(() => stock.prepareRestock("sku-1", Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(formatUnits(-2500, 4)).toBe("-0.2500");
  });
});

describe("wallet and inventory in one D1 transaction", () => {
  it("opens, credits, reserves, captures and explicitly refunds with audited before/after balances", async () => {
    await seed();
    expect(await commit("reserve", w.prepareReserve(account, "r1", "1.4", source), stock.prepareReserve("sku-1", "r1", 2, source))).toEqual({ status: "applied" });
    expect(await w.getBalance(account)).toMatchObject({ available: "8.6000", held: "1.4000", consumed: "0.0000", credited: "10.0000" });
    expect(await stock.getBalance("sku-1")).toMatchObject({ available: "8", held: "2" });

    await commit("capture", w.prepareCapture(account, "r1"), stock.prepareCapture("sku-1", "r1"));
    expect(await w.getBalance(account)).toMatchObject({ available: "8.6000", held: "0.0000", consumed: "1.4000" });
    expect(await w.getReservation(account, "r1")).toEqual({ id: "r1", amount: "1.4000", state: "captured", source });
    await commit("refund", w.prepareRefund(account, "r1"), stock.prepareReturn("sku-1", "r1"));
    expect(await w.getBalance(account)).toMatchObject({ available: "10.0000", held: "0.0000", consumed: "0.0000", credited: "10.0000" });
    expect(await stock.getBalance("sku-1")).toMatchObject({ available: "10", held: "0", consumed: "0", credited: "10" });
    const entries = await w.listEntries(account);
    expect(entries.map((e) => e.kind)).toEqual(["refund", "capture", "reserve", "credit"]);
    expect(entries[0]).toMatchObject({ operationId: "refund", actor: command("refund").actor, reason: "verified operation", before: { consumed: "1.4000" }, after: { consumed: "0.0000" } });
    expect((await w.getReservation(account, "r1"))?.state).toBe("refunded");
  });

  it("releases just one reservation, preserving another reservation's funds", async () => {
    await seed();
    await commit("reserve", w.prepareReserve(account, "r1", "1.4", source), w.prepareReserve(account, "r2", "0.25", { type: "order", id: "order-2" }));
    await commit("release", w.prepareRelease(account, "r1"));
    expect(await w.getBalance(account)).toMatchObject({ available: "9.7500", held: "0.2500" });
    expect((await w.getReservation(account, "r1"))?.state).toBe("released");
    expect((await w.getReservation(account, "r2"))?.state).toBe("held");
  });

  it("rolls back wallet writes, receipts and reservations when stock is insufficient", async () => {
    await seed("10", 1);
    const beforeWallet = await counts("ext_wallet");
    const beforeInventory = await counts("ext_inventory");
    await expect(commit("order", w.prepareReserve(account, "r1", "10", source), stock.prepareReserve("sku-1", "r1", 2, source))).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await counts("ext_wallet")).toEqual(beforeWallet);
    expect(await counts("ext_inventory")).toEqual(beforeInventory);
    expect(await w.getBalance(account)).toMatchObject({ available: "10.0000", held: "0.0000" });
    // A failed transaction did not consume the command id.
    expect(await commit("order", w.prepareReserve(account, "r1", "10", source), stock.prepareReserve("sku-1", "r1", 1, source))).toEqual({ status: "applied" });
  });

  it("also rolls back stock written before an insufficient wallet", async () => {
    await seed("1", 10);
    await expect(commit("order", stock.prepareReserve("sku-1", "r1", 2, source), w.prepareReserve(account, "r1", "1.4", source))).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await stock.getBalance("sku-1")).toMatchObject({ available: "10", held: "0" });
    expect(await stock.getReservation("sku-1", "r1")).toBeNull();
  });

  it("only one of two concurrent orders can reserve the last wallet balance", async () => {
    await seed("10", 2);
    const results = await Promise.allSettled(["A", "B"].map((id) => commit(id,
      w.prepareReserve(account, id, "10", { type: "order", id }), stock.prepareReserve("sku-1", id, 1, { type: "order", id }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await w.getBalance(account)).toMatchObject({ available: "0.0000", held: "10.0000" });
    expect(await stock.getBalance("sku-1")).toMatchObject({ available: "1", held: "1" });
  });

  it("only one concurrent order can reserve the last stock", async () => {
    await seed("100", 1);
    const results = await Promise.allSettled(["A", "B"].map((id) => commit(id,
      w.prepareReserve(account, id, "10", { type: "order", id }), stock.prepareReserve("sku-1", id, 1, { type: "order", id }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await w.getBalance(account)).toMatchObject({ available: "90.0000", held: "10.0000" });
    expect(await stock.getBalance("sku-1")).toMatchObject({ available: "0", held: "1" });
  });

  it("concurrent confirm and reject have a single winner across both participants", async () => {
    await seed();
    await commit("reserve", w.prepareReserve(account, "r1", "1.4", source), stock.prepareReserve("sku-1", "r1", 2, source));
    const results = await Promise.allSettled([
      commit("confirm", w.prepareCapture(account, "r1"), stock.prepareCapture("sku-1", "r1")),
      commit("reject", w.prepareRelease(account, "r1"), stock.prepareRelease("sku-1", "r1")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const walletReservation = await w.getReservation(account, "r1");
    const stockReservation = await stock.getReservation("sku-1", "r1");
    expect(walletReservation?.state).toBe(stockReservation?.state);
    expect(await w.getBalance(account)).toMatchObject({ held: "0.0000" });
  });

  it("refuses an unknown reservation, repeat transition and refund before capture", async () => {
    await seed();
    await expect(commit("unknown", w.prepareCapture(account, "missing"))).rejects.toMatchObject({ code: "precondition_failed" });
    await commit("reserve", w.prepareReserve(account, "r1", "1", source));
    await expect(commit("early-refund", w.prepareRefund(account, "r1"))).rejects.toMatchObject({ code: "precondition_failed" });
    await commit("release", w.prepareRelease(account, "r1"));
    await expect(commit("repeat-release", w.prepareRelease(account, "r1"))).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(commit("late-confirm", w.prepareCapture(account, "r1"))).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("preserves exact decimal balances over mixed small amounts", async () => {
    await seed("10");
    for (const [i, amount] of ["1.4", "0.7", "0.25", "0.0001"].entries()) {
      await commit(`reserve-${i}`, w.prepareReserve(account, `r${i}`, amount, source));
      await commit(`capture-${i}`, w.prepareCapture(account, `r${i}`));
    }
    expect(await w.getBalance(account)).toMatchObject({ available: "7.6499", consumed: "2.3501", held: "0.0000" });
  });

  it("rejects credit overflow atomically", async () => {
    await commit("seed", w.prepareOpen(account), w.prepareCredit(account, "900719925474.0991"));
    await expect(commit("overflow", w.prepareCredit(account, "0.0001"))).rejects.toMatchObject({ code: "precondition_failed" });
    expect((await w.getBalance(account))?.available).toBe("900719925474.0991");
    expect(await w.listEntries(account)).toHaveLength(1);
  });
});

describe("durable idempotency", () => {
  it("replays the complete command without duplicating any ledger entries", async () => {
    await seed();
    const reserve = () => [w.prepareReserve(account, "r1", "1.4", source), stock.prepareReserve("sku-1", "r1", 2, source)];
    expect(await commit("reserve", ...reserve())).toEqual({ status: "applied" });
    const before = [await counts("ext_wallet"), await counts("ext_inventory")];
    expect(await commit("reserve", ...reserve())).toEqual({ status: "replayed" });
    expect([await counts("ext_wallet"), await counts("ext_inventory")]).toEqual(before);
    await commit("capture", w.prepareCapture(account, "r1"), stock.prepareCapture("sku-1", "r1"));
    // A delayed reserve retry cannot move a captured reservation backwards.
    expect(await commit("reserve", ...reserve())).toEqual({ status: "replayed" });
    expect((await w.getReservation(account, "r1"))?.state).toBe("captured");
  });

  it("concurrent duplicate requests apply exactly once", async () => {
    await seed();
    const results = await Promise.all(Array.from({ length: 5 }, () => commit("same",
      w.prepareReserve(account, "r1", "1.4", source), stock.prepareReserve("sku-1", "r1", 2, source))));
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "replayed")).toHaveLength(4);
    expect(await w.listEntries(account)).toHaveLength(2);
  });

  it("rejects reusing a command id with a changed amount, actor or participant set", async () => {
    await seed();
    await commit("reserve", w.prepareReserve(account, "r1", "1.4", source));
    await expect(commit("reserve", w.prepareReserve(account, "r1", "1.5", source))).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(commitLedgerOperations({ ...command("reserve"), actor: { type: "user", id: "another-admin" } }, [w.prepareReserve(account, "r1", "1.4", source)])).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(commit("reserve", stock.prepareReserve("sku-1", "r1", 2, source), w.prepareReserve(account, "r1", "1.4", source))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await stock.getReservation("sku-1", "r1")).toBeNull();
  });

  it("rejects a partial receipt restore inside the batch before new writes", async () => {
    // Simulate restoring just one extension's receipt table. An open-only
    // operation has no ledger FK, so this exercises the kit's own replay guard.
    await commit("open-both", w.prepareOpen(account), stock.prepareOpen("sku-1"));
    await d1.prepare("DELETE FROM ext_inventory_operations WHERE id = ?").bind("open-both").run();
    await expect(commit("open-both", w.prepareOpen(account), stock.prepareOpen("sku-1"))).rejects.toMatchObject({ code: "precondition_failed" });
    expect((await counts("ext_inventory")).operations).toBe(0);
  });
});

describe("identity and isolation", () => {
  it("returns no data and rejects mutations for another owner, unit or precision", async () => {
    await seed();
    await commit("reserve", w.prepareReserve(account, "r1", "1", source));
    const wrongRefs: LedgerAccount[] = [
      { ...account, owner: { type: "partner", id: "partner-2" } },
      { ...account, unit: "cash" }, { ...account, precision: 2 },
    ];
    for (const [i, wrong] of wrongRefs.entries()) {
      expect(await w.getBalance(wrong)).toBeNull();
      expect(await w.getReservation(wrong, "r1")).toBeNull();
      expect(await w.listEntries(wrong)).toEqual([]);
      await expect(commit(`bad-${i}`, w.prepareCapture(wrong, "r1"))).rejects.toMatchObject({ code: "precondition_failed" });
    }
    expect((await w.getBalance(account))?.held).toBe("1.0000");
  });

  it("cannot release another account's reservation even with a valid account ref", async () => {
    await seed();
    const other = { ...account, id: "wallet-2", owner: { type: "partner", id: "partner-2" } };
    await commit("open-other", w.prepareOpen(other), w.prepareCredit(other, "2"));
    await commit("reserve", w.prepareReserve(account, "r1", "1", source));
    await expect(commit("steal", w.prepareRelease(other, "r1"))).rejects.toMatchObject({ code: "precondition_failed" });
  });

  it("does not retain mutable caller account references", async () => {
    const mutable = { ...account, owner: { ...account.owner } };
    const plan = w.prepareOpen(mutable);
    mutable.owner.id = "changed-after-prepare";
    mutable.precision = 0;
    await commit("open", plan);
    expect(await w.getBalance(account)).not.toBeNull();
    expect(await w.getBalance(mutable)).toBeNull();
  });

  it("rejects different databases, forged plans, empty commands and unsafe prefixes before writing", async () => {
    const otherDb = (env as { MIGRATIONS_DB: D1Database }).MIGRATIONS_DB;
    const otherStock = createStockLedger(otherDb);
    await expect(commit("mixed", w.prepareOpen(account), otherStock.prepareOpen("sku-1"))).rejects.toThrow("same D1 binding");
    await expect(commit("forged", {} as LedgerOperation)).rejects.toThrow("unknown ledger operation");
    await expect(commit("empty")).rejects.toThrow();
    await expect(commitLedgerOperations({ ...command("valid"), reason: "" }, [w.prepareOpen(account)])).rejects.toThrow();
    expect(() => ledgerTables("ext_wallet; DROP TABLE users")).toThrow();
    expect((await counts("ext_wallet")).accounts).toBe(0);
  });
});


describe("signed corrections", () => {
  it("preserves gross top-ups and consumption with audited, replay-safe signed adjustments", async () => {
    await seed();
    await commit("hold", w.prepareReserve(account, "held", "2", source));
    await commit("minus", w.prepareAdjustment(account, "-0.25"));
    await commit("plus", w.prepareAdjustment(account, "+1.4"));
    expect(await commit("plus", w.prepareAdjustment(account, "+1.4"))).toEqual({ status: "replayed" });
    expect(await w.getBalance(account)).toMatchObject({ available: "9.1500", held: "2.0000", consumed: "0.0000", credited: "10.0000", adjusted: "1.1500" });
    await commit("capture", w.prepareCapture(account, "held"));
    await commit("refund", w.prepareRefund(account, "held"));
    expect(await w.getBalance(account)).toMatchObject({ available: "11.1500", credited: "10.0000", adjusted: "1.1500", consumed: "0.0000" });
    const adjustments = (await w.listEntries(account)).filter((e) => e.kind === "adjust");
    expect(adjustments).toHaveLength(2);
    expect(adjustments[0]).toMatchObject({ before: { available: "7.7500", adjusted: "-0.2500" }, after: { available: "9.1500", adjusted: "1.1500", credited: "10.0000" }, actor: { id: "admin-1" } });
  });
  it("cannot subtract reserved points or exceed safe counters", async () => {
    await seed(); await commit("hold", w.prepareReserve(account, "held", "9", source));
    await expect(commit("bad", w.prepareAdjustment(account, "-1.0001"))).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(commit("overflow", w.prepareAdjustment(account, "900719925474.0991"))).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await w.getBalance(account)).toMatchObject({ available: "1.0000", held: "9.0000", adjusted: "0.0000" });
  });
});
