import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { noDeclarativeDependents, requiredPluginsEnabled, writeCodeEnabled, writeCodeDisabled } from "../src/ext/code-lifecycle";
import { defineExtension } from "../src/ext/types";

const db = (env as { DB: D1Database }).DB;
const wallet = defineExtension({ id: "wallet", name: "Wallet", version: "0.1.0", coreApi: "^1.36.0", canDisable: { sql: "NOT EXISTS (SELECT 1 FROM pending_work)", message: "Pending work" } });
const dealer = defineExtension({ id: "dealer", name: "Dealer", version: "0.1.0", coreApi: "^1.36.0", requiresExtensions: ["wallet"] });
const registry = [wallet, dealer];
beforeAll(async () => {
  await db.prepare("CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS pending_work (id TEXT PRIMARY KEY)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, enabled INTEGER NOT NULL)").run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM extensions").run(); await db.prepare("DELETE FROM pending_work").run();
  await db.prepare("DELETE FROM declarative_extensions").run();
});

describe("code extension lifecycle guards", () => {
  it("rejects absent/disabled dependencies and preserves first install time", async () => {
    await expect(writeCodeEnabled(db, dealer, registry, 1)).rejects.toThrow();
    await expect(writeCodeEnabled(db, dealer, [dealer], 1)).rejects.toThrow();
    await writeCodeEnabled(db, wallet, registry, 2);
    await writeCodeEnabled(db, dealer, registry, 3);
    await writeCodeEnabled(db, dealer, registry, 4);
    expect(await db.prepare("SELECT installed_at FROM extensions WHERE id = 'dealer'").first("installed_at")).toBe(3);
  });
  it("blocks disabling active dependencies and unresolved work", async () => {
    await writeCodeEnabled(db, wallet, registry, 1); await writeCodeEnabled(db, dealer, registry, 2);
    await expect(writeCodeDisabled(db, wallet, registry, 3)).rejects.toThrow();
    await writeCodeDisabled(db, dealer, registry, 4);
    await db.prepare("INSERT INTO pending_work VALUES ('pending')").run();
    await expect(writeCodeDisabled(db, wallet, registry, 5)).rejects.toThrow("Pending work");
    expect(await db.prepare("SELECT enabled FROM extensions WHERE id = 'wallet'").first("enabled")).toBe(1);
    await db.prepare("DELETE FROM pending_work").run(); await writeCodeDisabled(db, wallet, registry, 6);
    expect(await db.prepare("SELECT enabled FROM extensions WHERE id = 'wallet'").first("enabled")).toBe(0);
  });
  it("keeps dependency invariants during competing enable/disable requests", async () => {
    await writeCodeEnabled(db, wallet, registry, 1);
    await Promise.allSettled([writeCodeEnabled(db, dealer, registry, 2), writeCodeDisabled(db, wallet, registry, 3)]);
    const rows = await db.prepare("SELECT id, enabled FROM extensions").all<{ id: string; enabled: number }>();
    const enabled = new Map(rows.results.map((r) => [r.id, r.enabled]));
    expect(enabled.get("dealer") === 1 && enabled.get("wallet") !== 1).toBe(false);
  });
  it("validates minimum core API, dependency identity and trusted predicates", () => {
    expect(() => defineExtension({ ...dealer, coreApi: "^1.35.0" })).toThrow(/1.36.0/);
    expect(() => defineExtension({ ...dealer, requiresExtensions: ["dealer"] })).toThrow();
    expect(() => defineExtension({ ...dealer, requiresExtensions: ["wallet", "wallet"] })).toThrow();
    expect(() => defineExtension({ ...wallet, canDisable: { sql: "1; DELETE FROM users", message: "bad" } })).toThrow();
  });
});

// 1.50.0:宣告式插件的相依,寫入時的條件。
describe("declarative dependency guards", () => {
  const needs = (id: string, requires: unknown, enabled = 1) =>
    db.prepare("INSERT INTO declarative_extensions (id, manifest, enabled) VALUES (?, ?, ?)").bind(id, JSON.stringify({ id, requiresExtensions: requires }), enabled).run();
  const holds = async (guard: { sql: string; binds: (string | number | null)[] }) =>
    (await db.prepare(`SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`).bind(...guard.binds).first<number>("ok")) === 1;

  it("a code plugin that an enabled declarative plugin needs stays enabled", async () => {
    await writeCodeEnabled(db, wallet, registry, 1);
    await needs("reviews", [{ id: "wallet", reason: "pays" }]);
    await expect(writeCodeDisabled(db, wallet, registry, 2)).rejects.toThrow();
    await db.prepare("UPDATE declarative_extensions SET enabled = 0").run();
    await writeCodeDisabled(db, wallet, registry, 3);
    expect(await db.prepare("SELECT enabled FROM extensions WHERE id = 'wallet'").first("enabled")).toBe(0);
  });

  it("ignores optional needs, needs for another identity, and rows it cannot read", async () => {
    await needs("a", [{ id: "wallet", optional: true }]);
    await needs("b", [{ id: "wallet", identity: "other/wallet" }]);
    await needs("c", "not a list");
    await needs("d", ["wallet", 3, null]);
    await db.prepare("INSERT INTO declarative_extensions (id, manifest, enabled) VALUES ('e', '{broken', 1)").run();
    expect(await holds(noDeclarativeDependents("wallet", "sz-ws/wallet"))).toBe(true);
    await needs("f", [{ id: "wallet", identity: "sz-ws/wallet" }]);
    expect(await holds(noDeclarativeDependents("wallet", "sz-ws/wallet"))).toBe(false);
    expect(await holds(noDeclarativeDependents("wallet", null))).toBe(false);
  });

  it("required plugins must be enabled at write time", async () => {
    expect(await holds(requiredPluginsEnabled({ code: [], declarative: [] }))).toBe(true);
    await writeCodeEnabled(db, wallet, registry, 1);
    await needs("stock", [], 0);
    expect(await holds(requiredPluginsEnabled({ code: ["wallet"], declarative: [] }))).toBe(true);
    expect(await holds(requiredPluginsEnabled({ code: ["wallet"], declarative: ["stock"] }))).toBe(false);
    await db.prepare("UPDATE declarative_extensions SET enabled = 1 WHERE id = 'stock'").run();
    expect(await holds(requiredPluginsEnabled({ code: ["wallet"], declarative: ["stock"] }))).toBe(true);
  });
});
