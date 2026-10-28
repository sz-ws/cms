import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// POST /api/registry/install 指定 registry 保留的舊版本(body.version)。

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
      "CREATE TABLE IF NOT EXISTS declarative_previous (id TEXT PRIMARY KEY NOT NULL, manifest TEXT NOT NULL, version TEXT NOT NULL, source TEXT, stylesheet TEXT, scripts_approval TEXT, replaced_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    ].map((sql) => d1().prepare(sql)),
  );
});

beforeEach(async () => {
  await d1().batch(
    ["DELETE FROM declarative_extensions;", "DELETE FROM settings;", "DELETE FROM login_attempts;"].map((sql) => d1().prepare(sql)),
  );
  registryState.manifests.clear();
  registryState.calls = [];
});

describe("install: a version the registry kept", () => {
  it("抓指定的那一版,裝進去的就是它", async () => {
    registryState.manifests.set("pay@0.2.2", manifest("0.2.2"));
    const res = await post({ id: "pay", source: SOURCE, version: "0.2.2" });
    expect(res.status).toBe(200);
    expect(registryState.calls).toEqual([{ id: "pay", version: "0.2.2" }]);
    const row = await d1().prepare("SELECT version FROM declarative_extensions WHERE id = 'pay'").first<{ version: string }>();
    expect(row?.version).toBe("0.2.2");
  });

  it("抓回來的 manifest 不是那一版:400", async () => {
    registryState.manifests.set("pay@0.2.2", manifest("0.3.0"));
    const res = await post({ id: "pay", source: SOURCE, version: "0.2.2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_manifest" });
  });

  it("版本格式不對:400,不去抓", async () => {
    const res = await post({ id: "pay", source: SOURCE, version: "latest" });
    expect(res.status).toBe(400);
    expect(registryState.calls).toEqual([]);
  });
});
