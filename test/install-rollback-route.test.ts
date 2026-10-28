import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// POST /api/registry/install 的「回到上一版」(body.rollback,migrations/0027 的 declarative_previous)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ id: "u-admin", email: "a@t.co", name: "A", role: "admin" as const }),
  };
});
vi.mock("@/lib/security", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/security")>();
  return { ...actual, assertSameOrigin: () => {} };
});

const SOURCE = "https://registry-a.test";
const registryState = vi.hoisted(() => ({
  manifests: new Map<string, unknown>(),
  calls: [] as { id: string; version?: string }[],
}));
vi.mock("@/lib/registry-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/registry-client")>();
  return {
    ...actual,
    assertKnownRegistrySource: async (source: string) => {
      if (source !== "https://registry-a.test") throw new actual.UnknownRegistrySource(source);
    },
    fetchManifest: async (_source: string, id: string, version?: string) => {
      registryState.calls.push({ id, version });
      const manifest = registryState.manifests.get(`${id}@${version ?? "latest"}`);
      if (!manifest) throw new Error("http 404");
      return manifest;
    },
    sourceAllowsScripts: async () => false,
  };
});

vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    all: [],
    enabled: [],
    byId: () => undefined,
    hooks: { doAction: async () => {}, applyFilters: async (_n: string, v: unknown) => v },
  }),
  invalidateExtRuntimeMemo: () => {},
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => {} }));

import { POST } from "../src/app/api/registry/install/route";

const d1 = () => (env as { DB: D1Database }).DB;

const post = (body: unknown) =>
  POST(
    new Request("https://cms.test/api/registry/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const manifest = (version: string) => ({ kind: "declarative", id: "pay", name: "pay", version, coreApi: "^1.0.0" });

beforeAll(async () => {
  await d1().batch(
    [
      "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS declarative_previous (id TEXT PRIMARY KEY NOT NULL, manifest TEXT NOT NULL, version TEXT NOT NULL, source TEXT, stylesheet TEXT, scripts_approval TEXT, replaced_at INTEGER NOT NULL);",
    ].map((sql) => d1().prepare(sql)),
  );
});

beforeEach(async () => {
  await d1().batch(
    ["DELETE FROM declarative_extensions;", "DELETE FROM settings;", "DELETE FROM login_attempts;", "DELETE FROM ext_migrations;", "DELETE FROM declarative_previous;"].map((sql) => d1().prepare(sql)),
  );
  registryState.manifests.clear();
  registryState.calls = [];
});

const publish = (version: string, extra: Record<string, unknown> = {}) =>
  registryState.manifests.set("pay@latest", { ...manifest(version), ...extra });

async function installed() {
  return d1().prepare("SELECT version FROM declarative_extensions WHERE id = 'pay'").first<{ version: string }>();
}
async function previous() {
  return d1().prepare("SELECT version, source FROM declarative_previous WHERE id = 'pay'").first<{ version: string; source: string | null }>();
}

describe("install: rollback to the version before the last update", () => {
  it("更新時把被換掉的那一份存起來", async () => {
    publish("0.1.0");
    expect((await post({ id: "pay", source: SOURCE })).status).toBe(200);
    expect(await previous()).toBeNull();

    publish("0.2.0");
    expect((await post({ id: "pay", source: SOURCE })).status).toBe(200);
    expect(await previous()).toEqual({ version: "0.1.0", source: SOURCE });
  });

  it("換回上一版,剛才那一版變成上一份(可以再換回來),不抓 registry", async () => {
    publish("0.1.0");
    await post({ id: "pay", source: SOURCE });
    publish("0.2.0");
    await post({ id: "pay", source: SOURCE });
    registryState.calls = [];

    const res = await post({ id: "pay", rollback: true });
    expect(res.status).toBe(200);
    expect((await installed())?.version).toBe("0.1.0");
    expect((await previous())?.version).toBe("0.2.0");
    expect(registryState.calls).toEqual([]);
  });

  it("同一份內容重裝,不蓋掉上一份", async () => {
    publish("0.1.0");
    await post({ id: "pay", source: SOURCE });
    publish("0.2.0");
    await post({ id: "pay", source: SOURCE });
    await post({ id: "pay", source: SOURCE });
    expect((await previous())?.version).toBe("0.1.0");
  });

  it("沒有上一份:404", async () => {
    publish("0.1.0");
    await post({ id: "pay", source: SOURCE });
    const res = await post({ id: "pay", rollback: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_previous_version" });
  });

  it("兩版的 migration 不同:照一般更新擋下,裝著的不變", async () => {
    publish("0.1.0");
    await post({ id: "pay", source: SOURCE });
    publish("0.2.0", { migrations: ["CREATE TABLE IF NOT EXISTS pay_extra (id TEXT)"] });
    expect((await post({ id: "pay", source: SOURCE })).status).toBe(200);

    const res = await post({ id: "pay", rollback: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "migration_history_changed" });
    expect((await installed())?.version).toBe("0.2.0");
  });

  it("rollback 不能和來源或版本一起送", async () => {
    expect((await post({ id: "pay", rollback: true, source: SOURCE })).status).toBe(400);
    expect((await post({ id: "pay", rollback: true, version: "0.1.0" })).status).toBe(400);
  });
});
