import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";

// runDeclarativeMigrations 的 binding-backed 整合測試(miniflare D1)。
// db() 走 @opennextjs/cloudflare 的 getCloudflareContext(pool-workers 內不可用),
// 所以 mock @/lib/cf 讓 getDB 直接回傳 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import {
  buildDeclarativeMigrationBatch,
  buildInstallRevisionClaim,
  runDeclarativeMigrations,
  migrationKey,
} from "../src/ext/dx/declarative-migrate";
import { db } from "../src/lib/db";
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  // 與 src/lib/schema.ts extMigrations 同形(migrations/0000 內的定義)。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);",
  );
});

describe("migrationKey", () => {
  it("zero-pads the index to 4 digits", () => {
    expect(migrationKey("demo", 0)).toBe("demo:0000");
    expect(migrationKey("demo", 12)).toBe("demo:0012");
  });
});

describe("runDeclarativeMigrations (miniflare D1)", () => {
  const SQLS = [
    "CREATE TABLE IF NOT EXISTS ext_demo_items (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS ext_demo_items_label ON ext_demo_items (label)",
  ] as const;

  it("creates the declared tables and records applied keys", async () => {
    await runDeclarativeMigrations("demo", [...SQLS]);

    const table = await d1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ext_demo_items'",
      )
      .first<{ name: string }>();
    expect(table?.name).toBe("ext_demo_items");

    const applied = await d1()
      .prepare("SELECT id FROM ext_migrations WHERE ext_id = 'demo' ORDER BY id")
      .all<{ id: string }>();
    expect(applied.results.map((r) => r.id)).toEqual([
      "demo:0000",
      "demo:0001",
    ]);
  });

  it("re-running is a no-op (idempotent via ext_migrations skip)", async () => {
    await runDeclarativeMigrations("demo", [...SQLS]);
    const applied = await d1()
      .prepare(
        "SELECT COUNT(*) AS n FROM ext_migrations WHERE ext_id = 'demo'",
      )
      .first<{ n: number }>();
    expect(applied?.n).toBe(2);
  });

  it("empty migrations list is an early-return no-op", async () => {
    await expect(runDeclarativeMigrations("empty-ext", [])).resolves.toBeUndefined();
    const applied = await d1()
      .prepare("SELECT COUNT(*) AS n FROM ext_migrations WHERE ext_id = 'empty-ext'")
      .first<{ n: number }>();
    expect(applied?.n).toBe(0);
  });

  it("swallows 'already exists' race but still throws real SQL errors", async () => {
    // 表已存在但 ext_migrations 無記錄(模擬 race 的後到 request)→ 吞掉、繼續。
    await d1().exec(
      "CREATE TABLE IF NOT EXISTS ext_race_t (id TEXT PRIMARY KEY);",
    );
    await expect(
      runDeclarativeMigrations("race", [
        // 不帶 IF NOT EXISTS 的 CREATE(zod 層擋,但 helper 對 race 的容錯要成立)
        "CREATE TABLE ext_race_t (id TEXT PRIMARY KEY)",
      ]),
    ).resolves.toBeUndefined();

    // 真正的 SQL 錯誤(語法錯)→ throw 給呼叫端。
    await expect(
      runDeclarativeMigrations("broken", ["CREATE TABLE"]),
    ).rejects.toThrow();
  });
});

describe("declarative migration atomic batch", () => {
  it("rolls back DDL and migration markers when a later batch item fails", async () => {
    const items = await buildDeclarativeMigrationBatch(
      "atomic-fail",
      ["CREATE TABLE IF NOT EXISTS ext_atomic_fail (id TEXT PRIMARY KEY)"],
      Date.now(),
    );
    items.push(db().run(sql.raw("INSERT INTO table_that_does_not_exist VALUES (1)")));

    await expect(
      db().batch(items as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]),
    ).rejects.toThrow();

    const table = await d1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ext_atomic_fail'",
      )
      .first<{ name: string }>();
    expect(table).toBeNull();
    const marker = await d1()
      .prepare("SELECT id FROM ext_migrations WHERE ext_id = 'atomic-fail'")
      .first<{ id: string }>();
    expect(marker).toBeNull();
  });

  it("allows only one install batch to commit from an observed revision", async () => {
    const revision = 100;
    const first = [
      buildInstallRevisionClaim("revision-race", revision, 101),
      db().run(
        sql.raw(
          "CREATE TABLE IF NOT EXISTS ext_revision_winner (id TEXT PRIMARY KEY)",
        ),
      ),
    ] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
    const stale = [
      buildInstallRevisionClaim("revision-race", revision, 102),
      db().run(
        sql.raw(
          "CREATE TABLE IF NOT EXISTS ext_revision_stale (id TEXT PRIMARY KEY)",
        ),
      ),
    ] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

    await db().batch(first);
    await expect(db().batch(stale)).rejects.toThrow(/UNIQUE constraint/);
    const staleTable = await d1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ext_revision_stale'",
      )
      .first<{ name: string }>();
    expect(staleTable).toBeNull();

    await expect(
      db().batch([
        buildInstallRevisionClaim("revision-race", 101, 103),
      ]),
    ).resolves.toBeDefined();
  });

  it("rejects a stale prepared batch and rolls back its DDL", async () => {
    const sqls = [
      "CREATE TABLE IF NOT EXISTS ext_atomic_race (id TEXT PRIMARY KEY)",
    ];
    const first = await buildDeclarativeMigrationBatch(
      "atomic-race",
      sqls,
      Date.now(),
    );
    const second = await buildDeclarativeMigrationBatch(
      "atomic-race",
      [
        ...sqls,
        "CREATE TABLE IF NOT EXISTS ext_atomic_stale_extra (id TEXT PRIMARY KEY)",
      ],
      Date.now(),
    );
    await db().batch(first as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    await expect(
      db().batch(second as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]),
    ).rejects.toThrow(/UNIQUE constraint/);
    const markers = await d1()
      .prepare("SELECT COUNT(*) AS n FROM ext_migrations WHERE ext_id = 'atomic-race'")
      .first<{ n: number }>();
    expect(markers?.n).toBe(1);
    const staleTable = await d1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ext_atomic_stale_extra'",
      )
      .first<{ name: string }>();
    expect(staleTable).toBeNull();
  });
});
