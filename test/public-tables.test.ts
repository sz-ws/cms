import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.0 頁面快取,插件那一邊:
//   1. Extension.publicTables —— 「這些表的資料會上公開頁」。經 ledger-kit 的交易寫到這些表(庫存的扣、補、
//      退),交易成立之後 core 替插件通知 publicContentChanged,插件不用寫一行。同 jobs[].wakeOn 的宣告方式。
//   2. services.publicContentChanged(reason) —— 插件用 services.db 直接寫自己的公開資料時自己呼叫。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// services.ts 會 import 真的 loader(registry → next/navigation),workers pool 載不起來;這裡用不到它。
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({ enabled: [], byId: () => undefined }) }));

const publicCache = vi.hoisted(() => ({ reasons: [] as string[] }));
vi.mock("@/lib/public-cache", () => ({
  publicContentChanged: (reason: string) => {
    publicCache.reasons.push(reason);
  },
}));

import { setPublicTables } from "../src/lib/public-tables";
import { commitLedgerOperations, createLedgerProvider, ledgerSchema, prepareTransaction, transactionSchema } from "../src/ext/ledger-kit";
import type { LedgerAccount } from "../src/ext/ledger-kit";
import { ledgerTables } from "../src/ext/ledger-kit/schema";
import { defineExtension } from "../src/ext/types";
import { scopedServices } from "../src/ext/services";
import { HookBus } from "../src/ext/hooks";
import type { ProviderRegistry } from "../src/ext/providers";
import type { SlotRegistry } from "../src/ext/slots";

const d1 = () => (env as { DB: D1Database }).DB;
const STOCK = "ext_pubstock";
const OTHER = "ext_pubother";
const item = (sku: string): LedgerAccount => ({ id: sku, owner: { type: "sku", id: sku }, unit: "item", precision: 0 });
const command = (id: string) => ({ id, actor: { type: "system", id: "test" }, reason: "test" });

beforeAll(async () => {
  for (const prefix of [STOCK, OTHER]) {
    for (const sql of [...ledgerSchema(prefix).split(";"), ...transactionSchema(prefix).split(";")].map((s) => s.trim()).filter(Boolean)) {
      await d1().prepare(sql).run();
    }
  }
  await d1().prepare(`CREATE TABLE IF NOT EXISTS ${STOCK}_notes (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`).run();
});

beforeEach(async () => {
  for (const prefix of [STOCK, OTHER]) {
    const t = ledgerTables(prefix);
    for (const table of [t.ledger, t.reservations, t.operations, t.accounts]) await d1().prepare(`DELETE FROM ${table}`).run();
  }
  await d1().prepare(`DELETE FROM ${STOCK}_notes`).run();
  setPublicTables([]);
  publicCache.reasons = [];
});

describe("ledger-kit commits on declared public tables", () => {
  it("a stock change on a declared accounts table refreshes public pages once, after it commits", async () => {
    setPublicTables([`${STOCK}_accounts`]);
    const stock = createLedgerProvider(d1(), STOCK);
    expect(await commitLedgerOperations(command("open"), [stock.prepareOpen(item("sku-1")), stock.prepareCredit(item("sku-1"), "5")])).toEqual({ status: "applied" });
    expect(publicCache.reasons).toEqual([`ledger:${STOCK}_accounts`]);
  });

  it("a replayed command changes nothing and tells nobody", async () => {
    setPublicTables([`${STOCK}_accounts`]);
    const stock = createLedgerProvider(d1(), STOCK);
    const ops = () => [stock.prepareOpen(item("sku-2"))];
    await commitLedgerOperations(command("same"), ops());
    publicCache.reasons = [];
    expect(await commitLedgerOperations(command("same"), ops())).toEqual({ status: "replayed" });
    expect(publicCache.reasons).toEqual([]);
  });

  it("a failed commit tells nobody", async () => {
    setPublicTables([`${STOCK}_accounts`]);
    const stock = createLedgerProvider(d1(), STOCK);
    await expect(commitLedgerOperations(command("bad"), [stock.prepareCredit(item("missing"), "1")])).rejects.toBeTruthy();
    expect(publicCache.reasons).toEqual([]);
  });

  it("tables nobody declared do not refresh anything", async () => {
    setPublicTables([`${STOCK}_accounts`]);
    const other = createLedgerProvider(d1(), OTHER);
    await commitLedgerOperations(command("other"), [other.prepareOpen(item("x"))]);
    expect(publicCache.reasons).toEqual([]);
  });

  it("a transaction that inserts into a declared table counts too", async () => {
    setPublicTables([`${STOCK}_notes`]);
    await commitLedgerOperations(command("note"), [
      prepareTransaction(d1(), STOCK, [{ kind: "insert", table: `${STOCK}_notes`, values: { id: "n1", created_at: 1 } }]),
    ]);
    expect(publicCache.reasons).toEqual([`ledger:${STOCK}_notes`]);
  });
});

describe("Extension.publicTables", () => {
  const base = { id: "acme", name: "Acme", version: "1.0.0", coreApi: "^1.10.0" };

  it("accepts table names in the same shape as wakeOn", () => {
    expect(defineExtension({ ...base, publicTables: ["ext_acme_accounts"] }).publicTables).toEqual(["ext_acme_accounts"]);
  });

  it("refuses anything that is not a plain table name", () => {
    expect(() => defineExtension({ ...base, publicTables: ["ext_acme; DROP TABLE x"] })).toThrow(/publicTables/);
    expect(() => defineExtension({ ...base, publicTables: ["Ext"] })).toThrow(/publicTables/);
  });
});

describe("services.publicContentChanged", () => {
  it("is bound to the plugin: the reason starts with its id", () => {
    const services = scopedServices("acme", new HookBus(), {} as ProviderRegistry, {} as SlotRegistry);
    services.publicContentChanged("price");
    expect(publicCache.reasons).toEqual(["acme:price"]);
  });
});
