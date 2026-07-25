import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// POST /api/registry/install 的 inline-manifest 分支(dev-only)。
// 這條路徑刻意繞過 SSRF 護欄(它沒有遠端 source 可驗),所以值得真的整合測試
// 而不只是 schema 單元測試:要證明「繞過的只有抓取,manifest 驗證與寫入契約
// 一步都沒少」。
//
// 同其他 binding-backed 測試:mock @/lib/cf 讓 db() 打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const authState = vi.hoisted(() => ({
  user: { id: "u-admin", email: "a@t.co", name: "A", role: "admin" as const },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => authState.user,
  };
});
vi.mock("@/lib/security", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/security")>();
  return { ...actual, assertSameOrigin: () => {} };
});

// loader / cache 是 post-commit 的 best-effort 副作用,且 loader 的相依鏈含
// next/navigation(workers pool 地雷,見 ext-jobs.test.ts 同款註解)。
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    all: [],
    enabled: [],
    byId: () => undefined,
    // post-commit 會 doAction("extension:installed");route 對這段是 best-effort
    // (失敗只 log、不改回應碼),但 mock 補齊才不會讓測試輸出充滿假的 stderr。
    hooks: { doAction: async () => {}, applyFilters: async (_n: string, v: unknown) => v },
  }),
  invalidateExtRuntimeMemo: () => {},
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => {} }));

import { POST } from "../src/app/api/registry/install/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const post = (body: unknown) =>
  POST(
    new Request("https://cms.test/api/registry/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const MANIFEST = {
  kind: "declarative",
  id: "recipes",
  name: "Recipes",
  version: "1.0.0",
  coreApi: "^1.0.0",
  description: "A recipe collection.",
  contentTypes: [
    {
      name: "recipe",
      label: "Recipe",
      slugField: "title",
      fields: [
        { key: "title", type: "text", label: "Title", required: true },
        { key: "body", type: "richtext", label: "Method" },
      ],
    },
  ],
  adminPages: [
    { slug: "", title: "Recipes", view: "collection", contentType: "recipe" },
  ],
  publicRoutes: [
    { pattern: "/recipes", view: "list", contentType: "recipe" },
    { pattern: "/recipes/:slug", view: "detail", contentType: "recipe" },
  ],
};

beforeAll(async () => {
  await d1().batch(
    [
      "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    ].map((sql) => d1().prepare(sql)),
  );
});

beforeEach(async () => {
  await d1().batch(
    [
      "DELETE FROM declarative_extensions;",
      "DELETE FROM ext_migrations;",
      "DELETE FROM settings;",
      "DELETE FROM login_attempts;",
      "DELETE FROM extensions;",
    ].map((sql) => d1().prepare(sql)),
  );
});

describe("POST /api/registry/install — inline manifest (dev only)", () => {
  it("installs a manifest passed inline, with no registry source", async () => {
    const res = await post({ id: "recipes", manifest: MANIFEST });
    expect(res.status).toBe(200);

    const row = await d1()
      .prepare("SELECT id, version, enabled, source FROM declarative_extensions WHERE id = ?")
      .bind("recipes")
      .first<{ id: string; version: string; enabled: number; source: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.version).toBe("1.0.0");
    expect(row!.enabled).toBe(1);
    // 沒有 registry 來源 → 明確存 NULL,而不是空字串或假的 URL。
    expect(row!.source).toBeNull();
  });

  it("still runs full manifest validation — a bad manifest is refused", async () => {
    const res = await post({
      id: "recipes",
      // contentTypes[].fields[].type 不是合法的 field type
      manifest: { ...MANIFEST, contentTypes: [{ ...MANIFEST.contentTypes[0], fields: [{ key: "x", type: "not-a-real-type", label: "X" }] }] },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_manifest");
    const row = await d1()
      .prepare("SELECT id FROM declarative_extensions WHERE id = ?")
      .bind("recipes")
      .first();
    expect(row).toBeNull();
  });

  it("refuses both `source` and `manifest`", async () => {
    const res = await post({
      id: "recipes",
      source: "https://raw.githubusercontent.com/sz-ws/registry/main",
      manifest: MANIFEST,
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_input");
  });

  it("refuses neither `source` nor `manifest`", async () => {
    const res = await post({ id: "recipes" });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_input");
  });

  it("refuses an inline manifest that declares a stylesheet — nothing to fetch it from", async () => {
    const res = await post({
      id: "recipes",
      manifest: { ...MANIFEST, coreApi: "^1.8.0", stylesheet: "style.css" },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("invalid_stylesheet");
    // fail fast:任何 DB 寫入之前就擋下
    const row = await d1()
      .prepare("SELECT id FROM declarative_extensions WHERE id = ?")
      .bind("recipes")
      .first();
    expect(row).toBeNull();
  });

  it("refuses when the id collides with a compiled-in code extension", async () => {
    await d1()
      .prepare("INSERT INTO extensions (id, enabled, installed_at) VALUES (?, 1, ?)")
      .bind("recipes", Date.now())
      .run();
    const res = await post({ id: "recipes", manifest: MANIFEST });
    expect(res.status).toBe(409);
  });
});
