import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("@/../extensions/registry", () => ({ registry: [] }));
vi.mock("@/ext/loader", () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({
    hooks: { doAction: async () => undefined },
  }),
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));

import {
  disableDeclarative,
  enableDeclarative,
  uninstallDeclarative,
} from "../src/ext/manager";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec(
    "DELETE FROM declarative_extensions; DELETE FROM ext_migrations; DELETE FROM settings; DELETE FROM contents;",
  );
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id,manifest,version,enabled,installed_at,updated_at) VALUES ('demo','{}','1.0.0',1,100,100)",
    )
    .run();
});

describe("declarative manager revision lifecycle", () => {
  it("advances revision through disable and enable claims", async () => {
    await disableDeclarative("demo");
    const disabled = await d1()
      .prepare("SELECT enabled, updated_at FROM declarative_extensions WHERE id='demo'")
      .first<{ enabled: number; updated_at: number }>();
    expect(disabled?.enabled).toBe(0);
    expect(disabled!.updated_at).toBeGreaterThan(100);

    await enableDeclarative("demo");
    const enabled = await d1()
      .prepare("SELECT enabled, updated_at FROM declarative_extensions WHERE id='demo'")
      .first<{ enabled: number; updated_at: number }>();
    expect(enabled?.enabled).toBe(1);
    expect(enabled!.updated_at).toBeGreaterThan(disabled!.updated_at);
  });

  it("removes positional migrations but retains a revision tombstone", async () => {
    await d1()
      .prepare(
        "INSERT INTO ext_migrations (id,ext_id,applied_at) VALUES ('demo:0000','demo',100),('demo:install:99','demo',100)",
      )
      .run();
    await uninstallDeclarative("demo", false);
    const row = await d1()
      .prepare("SELECT id FROM declarative_extensions WHERE id='demo'")
      .first();
    const markers = await d1()
      .prepare("SELECT id FROM ext_migrations WHERE ext_id='demo' ORDER BY id")
      .all<{ id: string }>();
    expect(row).toBeNull();
    expect(markers.results.every((marker) => marker.id.includes(":install:"))).toBe(
      true,
    );
    expect(markers.results.length).toBeGreaterThan(0);
  });
});
