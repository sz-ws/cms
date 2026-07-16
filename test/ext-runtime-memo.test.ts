import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// computeExtRuntimeStamp 的 binding-backed 整合測試(miniflare D1)。
// 同 declarative-migrate.test.ts:mock @/lib/cf 讓 getDB 直接回傳 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { computeExtRuntimeStamp } from "../src/ext/runtime-stamp";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  // 與 migrations/0000(extensions)、0001(declarative_extensions)同形。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions;");
  await d1().exec("DELETE FROM declarative_extensions;");
});

async function insertDx(id: string, enabled: number, updatedAt: number): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES (?, '{}', '1.0.0', ?, NULL, ?, ?)",
    )
    .bind(id, enabled, updatedAt, updatedAt)
    .run();
}

async function insertExt(id: string, enabled: number, updatedAt: number): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, ?, '1.0.0', ?, ?)",
    )
    .bind(id, enabled, updatedAt, updatedAt)
    .run();
}

describe("computeExtRuntimeStamp", () => {
  it("returns the empty-table baseline", async () => {
    expect(await computeExtRuntimeStamp()).toBe("0:0:0|0:0:0");
  });

  it("is stable across identical reads (no mutation between)", async () => {
    await insertDx("a", 1, 1000);
    const s1 = await computeExtRuntimeStamp();
    const s2 = await computeExtRuntimeStamp();
    expect(s1).toBe(s2);
  });

  it("changes when a row is inserted", async () => {
    const before = await computeExtRuntimeStamp();
    await insertDx("a", 1, 1000);
    const after = await computeExtRuntimeStamp();
    expect(after).not.toBe(before);
  });

  it("changes when a declarative row's updated_at bumps (mutation path fingerprint)", async () => {
    await insertDx("a", 1, 1000);
    const before = await computeExtRuntimeStamp();
    // 模擬 enable/disable/install 的寫入:bump updated_at(即使 enabled 值不變也會反映)。
    await d1()
      .prepare("UPDATE declarative_extensions SET updated_at = ? WHERE id = ?")
      .bind(2000, "a")
      .run();
    const after = await computeExtRuntimeStamp();
    expect(after).not.toBe(before);
  });

  it("changes when enabled toggles (disable path: enabled 1→0 + updated_at bump)", async () => {
    await insertDx("a", 1, 1000);
    const before = await computeExtRuntimeStamp();
    // 對齊 manager.disableDeclarative:同時改 enabled 與 updated_at。
    await d1()
      .prepare("UPDATE declarative_extensions SET enabled = 0, updated_at = ? WHERE id = ?")
      .bind(2000, "a")
      .run();
    const after = await computeExtRuntimeStamp();
    expect(after).not.toBe(before);
  });

  it("changes when a row is deleted (uninstall path)", async () => {
    await insertDx("a", 1, 1000);
    const before = await computeExtRuntimeStamp();
    await d1().exec("DELETE FROM declarative_extensions WHERE id = 'a';");
    const after = await computeExtRuntimeStamp();
    expect(after).not.toBe(before);
  });

  it("fingerprints the extensions (code) table too", async () => {
    const before = await computeExtRuntimeStamp();
    await insertExt("code-a", 1, 1000);
    const afterInsert = await computeExtRuntimeStamp();
    expect(afterInsert).not.toBe(before);

    // enable→disable(manager.disableExtension:enabled=0 + updated_at bump)。
    await d1()
      .prepare("UPDATE extensions SET enabled = 0, updated_at = ? WHERE id = ?")
      .bind(2000, "code-a")
      .run();
    const afterDisable = await computeExtRuntimeStamp();
    expect(afterDisable).not.toBe(afterInsert);
  });

  it("distinguishes the two tables (a code change does not alias a dx change)", async () => {
    await insertExt("code-a", 1, 1000);
    const codeOnly = await computeExtRuntimeStamp();
    await insertDx("dx-a", 1, 1000);
    const both = await computeExtRuntimeStamp();
    expect(both).not.toBe(codeOnly);
  });
});
