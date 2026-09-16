import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { writeCodeEnabled, writeCodeDisabled } from "../src/ext/code-lifecycle";
import { defineExtension } from "../src/ext/types";

const db = (env as { DB: D1Database }).DB;
const wallet = defineExtension({ id: "wallet", name: "Wallet", version: "0.1.0", coreApi: "^1.36.0", canDisable: { sql: "NOT EXISTS (SELECT 1 FROM pending_work)", message: "Pending work" } });
const dealer = defineExtension({ id: "dealer", name: "Dealer", version: "0.1.0", coreApi: "^1.36.0", requiresExtensions: ["wallet"] });
const registry = [wallet, dealer];
beforeAll(async () => {
  await db.prepare("CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS pending_work (id TEXT PRIMARY KEY)").run();
});
beforeEach(async () => { await db.prepare("DELETE FROM extensions").run(); await db.prepare("DELETE FROM pending_work").run(); });

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
