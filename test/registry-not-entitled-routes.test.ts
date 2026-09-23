import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 付費插件協定 1:registry 對 manifest 回 402 時,預覽與安裝兩條 route 都回
// 402 { error: "not_entitled", message }(不再包成 502 manifest_fetch_failed);金鑰本身
// 不能用(401 / 403)回 502 source_key_invalid。其他失敗照舊。
// registry-client 的 fetchManifest 以 mock 代替(不打網路),丟的是真的 RegistryHttpError。

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

const SOURCE = "https://registry.example.com";
const registryState = vi.hoisted(() => ({ failure: null as null | { status: number; code?: string; detail?: string } }));
vi.mock("@/lib/registry-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/registry-client")>();
  return {
    ...actual,
    assertKnownRegistrySource: async (source: string) => {
      if (source !== "https://registry.example.com") throw new actual.UnknownRegistrySource(source);
    },
    fetchManifest: async () => {
      const f = registryState.failure;
      if (!f) throw new Error("http 404");
      throw new actual.RegistryHttpError(f.status, f.code, f.detail);
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

import { POST as install } from "../src/app/api/registry/install/route";
import { GET as preview } from "../src/app/api/registry/manifest/route";

const d1 = () => (env as { DB: D1Database }).DB;

const post = () =>
  install(
    new Request("https://cms.test/api/registry/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "session-replay", source: SOURCE }),
    }),
  );
const get = () =>
  preview(new Request(`https://cms.test/api/registry/manifest?source=${encodeURIComponent(SOURCE)}&id=session-replay`));

beforeAll(async () => {
  await d1().batch(
    [
      "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
    ].map((sql) => d1().prepare(sql)),
  );
});

beforeEach(async () => {
  await d1().batch(["DELETE FROM login_attempts;", "DELETE FROM declarative_extensions;"].map((sql) => d1().prepare(sql)));
  registryState.failure = null;
});

describe("registry routes: a plugin this key has not been given", () => {
  for (const [name, call] of [
    ["GET /api/registry/manifest", get],
    ["POST /api/registry/install", post],
  ] as const) {
    it(`${name} answers 402 not_entitled with the provider's message`, async () => {
      registryState.failure = { status: 402, code: "not_entitled", detail: "請聯絡提供者開通。" };
      const res = await call();
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: "not_entitled", message: "請聯絡提供者開通。" });
    });

    it(`${name}: any 402 counts, with or without a message`, async () => {
      registryState.failure = { status: 402 };
      const res = await call();
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: "not_entitled" });
    });

    it(`${name}: a key the registry refuses is a source problem, not this plugin's`, async () => {
      for (const status of [401, 403]) {
        registryState.failure = { status, code: "key_revoked" };
        const res = await call();
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "source_key_invalid" });
      }
    });

    it(`${name}: other failures are unchanged`, async () => {
      registryState.failure = { status: 500 };
      const res = await call();
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "manifest_fetch_failed", message: "http 500" });
    });
  }

  it("nothing is written when install is refused", async () => {
    registryState.failure = { status: 402, code: "not_entitled" };
    await post();
    const row = await d1().prepare("SELECT id FROM declarative_extensions").first();
    expect(row).toBeNull();
  });
});
