import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 額外欄位(data.extra)走後台 CRUD 的 binding-backed 整合測試(miniflare D1)。
// 同既有慣例(revisions / notify):mock @/lib/cf 讓 db()/getDB() 直接打 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// 版本快照的寫入者走 getSessionUser()(pool-workers 沒有 request cookies)。
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, getSessionUser: async () => null };
});

// @/ext/loader 全 mock:setSettings 會 dynamic import 它來派送 settings:saved,
// 真的 loader 會拉進 next/navigation(同 notify.test.ts 的說明)。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { buildCrudRoutes } from "../src/ext/dx/crud";
import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { setSettings, invalidateSettingsCache } from "../src/lib/settings";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import type { ApiCtx } from "../src/ext/types";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM content_revisions;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM login_attempts;");
  invalidateSettingsCache();
});

const POST_CT: DeclarativeContentType = {
  name: "post",
  label: "Post",
  slugField: "title",
  fields: [
    { key: "title", type: "text" },
    { key: "body", type: "text" },
  ],
};

const DEFS = [
  { key: "featured", label: "Featured", type: "boolean", public: true },
  { key: "subtitle", label: "Subtitle", type: "text", public: true },
  { key: "cost", label: "Cost", type: "number", public: false },
];

function makeCtx(provider: CoreContentProvider): ApiCtx {
  return {
    user: { id: "admin" },
    services: { providers: { get: () => provider } },
  } as unknown as ApiCtx;
}

function route(extId: string, ct: DeclarativeContentType, method: string, path: string) {
  const found = buildCrudRoutes(extId, ct).find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`route not found: ${method} ${path}`);
  return found;
}

function jsonReq(url: string, method: string, body: Record<string, unknown>): Request {
  return new Request(`https://cms.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function storedData(id: string): Promise<Record<string, unknown>> {
  const row = await d1()
    .prepare("SELECT data FROM contents WHERE id = ?")
    .bind(id)
    .first<{ data: string }>();
  return JSON.parse(row?.data ?? "{}") as Record<string, unknown>;
}

async function create(
  provider: CoreContentProvider,
  body: Record<string, unknown>,
  extId = "blog",
  ct = POST_CT,
): Promise<string> {
  const res = await route(extId, ct, "POST", ct.name).handler(
    jsonReq(`/api/ext/${extId}/${ct.name}`, "POST", body),
    {},
    makeCtx(provider),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

describe("admin create/update — data.extra", () => {
  it("create keeps declared extras with the right shape and drops the rest", async () => {
    await setSettings({ "core.content.extraFields": { "blog.post": DEFS } });
    const p = new CoreContentProvider(new HookBus());
    const id = await create(p, {
      title: "Hello",
      extra: { featured: "yes", subtitle: "  Hi  ", cost: 12, junk: "x" },
    });
    expect((await storedData(id)).extra).toEqual({ subtitle: "Hi", cost: 12 });
  });

  it("update replaces the whole extra object; an update without extra keeps it", async () => {
    await setSettings({ "core.content.extraFields": { "blog.post": DEFS } });
    const p = new CoreContentProvider(new HookBus());
    const id = await create(p, { title: "Hello", extra: { subtitle: "Hi", cost: 12 } });
    const put = route("blog", POST_CT, "PUT", "post/:id");

    const replaced = await put.handler(
      jsonReq(`/api/ext/blog/post/${id}`, "PUT", { extra: { featured: true, junk: 1 } }),
      { id },
      makeCtx(p),
    );
    expect(replaced.status).toBe(200);
    expect((await storedData(id)).extra).toEqual({ featured: true });

    const untouched = await put.handler(
      jsonReq(`/api/ext/blog/post/${id}`, "PUT", { title: "Hello again" }),
      { id },
      makeCtx(p),
    );
    expect(untouched.status).toBe(200);
    const data = await storedData(id);
    expect(data.title).toBe("Hello again");
    expect(data.extra).toEqual({ featured: true });

    // 送空物件 = 清空。
    await put.handler(jsonReq(`/api/ext/blog/post/${id}`, "PUT", { extra: {} }), { id }, makeCtx(p));
    expect((await storedData(id)).extra).toEqual({});
  });

  it("a type without definitions does not store extra at all", async () => {
    await setSettings({ "core.content.extraFields": { "blog.page": DEFS } });
    const p = new CoreContentProvider(new HookBus());
    const id = await create(p, { title: "Hello", extra: { subtitle: "Hi" } });
    expect(await storedData(id)).not.toHaveProperty("extra");
  });

  it("anonymous public create still drops extra (undeclared key)", async () => {
    await setSettings({ "core.content.extraFields": { "contact.message": DEFS } });
    const ct: DeclarativeContentType = {
      name: "message",
      label: "Message",
      public: true,
      fields: [{ key: "name", type: "text" }],
    };
    const p = new CoreContentProvider(new HookBus());
    const id = await create(p, { name: "Ada", extra: { subtitle: "Hi" } }, "contact", ct);
    expect(await storedData(id)).toEqual({ name: "Ada" });
  });
});
