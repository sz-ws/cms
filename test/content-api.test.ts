import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// roadmap #1 §6:Public Content API + API tokens 的 binding-backed 整合測試(miniflare D1)。
// 同既有測試:mock @/lib/cf 讓 getDB 直接回傳 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// content-cache 走 next/cache 的 unstable_cache + getExtRuntime(loader/registry/React
// cache),在 pool-workers 測試環境不穩且會跨 case 快取造成非確定性。此處以「直接查
// 真實 provider」取代快取層 —— 路由的語意(auth / gating / published-only / 白名單 /
// 分頁)完全不變,且對真實 contents 表讀取,只是拿掉 unstable_cache 記帳。
vi.mock("@/ext/dx/content-cache", async () => {
  const { CoreContentProvider } = await import(
    "../src/ext/dx/content-provider"
  );
  const { HookBus } = await import("../src/ext/hooks");
  const provider = new CoreContentProvider(new HookBus());
  return {
    cachedPublicQuery: (_extId: string, type: string, q: unknown) =>
      provider.query(type, q as never),
    cachedPublicGetBySlug: (_extId: string, type: string, slug: string) =>
      provider.getBySlug(type, slug),
    cachedExtStylesheet: async () => null,
  };
});

import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../src/lib/api-token";
import { GET } from "../src/app/api/content/[extId]/[type]/[[...rest]]/route";
import { parseManifest } from "../src/ext/dx/manifest";
import { satisfies } from "../src/ext/semver";
import { CORE_API_VERSION } from "../src/ext/version";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

function makeReq(
  path: string,
  init?: { token?: string },
): Request {
  const headers: Record<string, string> = {};
  if (init?.token) headers["Authorization"] = `Bearer ${init.token}`;
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

function params(extId: string, type: string, rest?: string[]) {
  return { params: Promise.resolve({ extId, type, rest }) };
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'read', last_used_at INTEGER, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM api_tokens;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM declarative_extensions;");
});

// ---- 測試 fixtures ----

async function insertDx(
  id: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, stylesheet, installed_at, updated_at) VALUES (?, ?, '1.0.0', 1, NULL, NULL, ?, ?)",
    )
    .bind(id, JSON.stringify(manifest), now, now)
    .run();
}

async function insertContent(
  type: string,
  slug: string | null,
  status: "draft" | "published",
  data: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `c-${Math.random().toString(36).slice(2)}`,
      type,
      slug,
      status,
      JSON.stringify(data),
      now,
      now,
    )
    .run();
}

const blogManifest = {
  kind: "declarative",
  id: "blog",
  name: "Blog",
  version: "1.0.0",
  coreApi: "^1.9.0",
  contentTypes: [
    {
      name: "post",
      fields: [
        { key: "title", type: "text" },
        { key: "category", type: "text" },
      ],
    },
  ],
};

async function seedBlog(): Promise<void> {
  await insertDx("blog", blogManifest);
  await insertContent("blog.post", "hello", "published", {
    title: "Hello",
    category: "news",
  });
  await insertContent("blog.post", "hidden", "draft", {
    title: "Hidden",
    category: "news",
  });
}

// ---- §6.1:建 token → raw sk_;DB 只存 hash(≠raw)+ prefix ----

describe("createApiToken (§6.1)", () => {
  it("returns a sk_ raw token; DB stores only hash (≠ raw) + prefix", async () => {
    const { raw, id, prefix } = await createApiToken("test");
    expect(raw.startsWith("sk_")).toBe(true);
    expect(prefix).toBe(raw.slice(0, 11));

    const row = await d1()
      .prepare("SELECT token_hash, prefix, scope FROM api_tokens WHERE id = ?")
      .bind(id)
      .first<{ token_hash: string; prefix: string; scope: string }>();
    expect(row).toBeTruthy();
    expect(row?.token_hash).not.toBe(raw); // 永不落庫 raw
    expect(row?.token_hash.length).toBe(64); // SHA-256 hex
    expect(row?.prefix).toBe(prefix);
    expect(row?.scope).toBe("read");

    // listApiTokens 絕不含 hash / raw。
    const list = await listApiTokens();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(raw);
    expect(JSON.stringify(list)).not.toContain(row?.token_hash);
  });
});

// ---- §6.2:無 token / 錯 token → 401;正確 → 200 ----

describe("auth (§6.2)", () => {
  it("401 without token, 401 with wrong token, 200 with correct token", async () => {
    await seedBlog();
    const { raw } = await createApiToken("ok");

    const noAuth = await GET(makeReq("/api/content/blog/post"), params("blog", "post"));
    expect(noAuth.status).toBe(401);

    const bad = await GET(
      makeReq("/api/content/blog/post", { token: "sk_wrongwrongwrong" }),
      params("blog", "post"),
    );
    expect(bad.status).toBe(401);

    const ok = await GET(
      makeReq("/api/content/blog/post", { token: raw }),
      params("blog", "post"),
    );
    expect(ok.status).toBe(200);
  });
});

// ---- §6.3:list 只回 published;detail 對 draft slug → 404 ----

describe("published-only (§6.3)", () => {
  it("list returns only published; detail on a draft slug → 404", async () => {
    await seedBlog();
    const { raw } = await createApiToken("ok");

    const res = await GET(
      makeReq("/api/content/blog/post", { token: raw }),
      params("blog", "post"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; status?: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("hello");
    // 恆為 published,回應不含 status。
    expect(body.items[0].status).toBeUndefined();

    const detailPub = await GET(
      makeReq("/api/content/blog/post/hello", { token: raw }),
      params("blog", "post", ["hello"]),
    );
    expect(detailPub.status).toBe(200);

    const detailDraft = await GET(
      makeReq("/api/content/blog/post/hidden", { token: raw }),
      params("blog", "post", ["hidden"]),
    );
    expect(detailDraft.status).toBe(404);
  });
});

// ---- §6.4:perPage clamp 到 100;filter 只吃白名單欄位(未宣告 → 忽略)----

describe("pagination + filter whitelist (§6.4)", () => {
  it("clamps perPage to 100 and ignores non-whitelisted filter fields", async () => {
    await insertDx("blog", blogManifest);
    for (let i = 0; i < 3; i++) {
      await insertContent("blog.post", `p-${i}`, "published", {
        title: `Post ${i}`,
        category: i === 0 ? "news" : "misc",
      });
    }
    const { raw } = await createApiToken("ok");

    // perPage=500 → clamp 100。
    const clamp = await GET(
      makeReq("/api/content/blog/post?perPage=500", { token: raw }),
      params("blog", "post"),
    );
    const clampBody = (await clamp.json()) as { perPage: number; total: number };
    expect(clampBody.perPage).toBe(100);
    expect(clampBody.total).toBe(3);

    // 白名單欄位 category=news → 1 筆。
    const filtered = await GET(
      makeReq("/api/content/blog/post?filter.category=news", { token: raw }),
      params("blog", "post"),
    );
    const filteredBody = (await filtered.json()) as { total: number };
    expect(filteredBody.total).toBe(1);

    // 未宣告欄位 bogus → 忽略(仍回全部 3 筆)。
    const bogus = await GET(
      makeReq("/api/content/blog/post?filter.bogus=zzz", { token: raw }),
      params("blog", "post"),
    );
    const bogusBody = (await bogus.json()) as { total: number };
    expect(bogusBody.total).toBe(3);
  });
});

// ---- §6.5:customApiRoutes 宣告後,未列入 → 403;未宣告 → 全 published type 可讀 ----

describe("customApiRoutes gating (§6.5)", () => {
  it("403 not_exposed for unlisted type; all types readable when undeclared", async () => {
    const { raw } = await createApiToken("ok");

    // shop 宣告 customApiRoutes,只開放 product。
    await insertDx("shop", {
      kind: "declarative",
      id: "shop",
      name: "Shop",
      version: "1.0.0",
      coreApi: "^1.9.0",
      contentTypes: [
        { name: "product", fields: [{ key: "title", type: "text" }] },
        { name: "secret", fields: [{ key: "title", type: "text" }] },
      ],
      customApiRoutes: [{ method: "GET", path: "/p", contentType: "product" }],
    });
    await insertContent("shop.product", "widget", "published", { title: "Widget" });
    await insertContent("shop.secret", "hush", "published", { title: "Hush" });

    const exposed = await GET(
      makeReq("/api/content/shop/product", { token: raw }),
      params("shop", "product"),
    );
    expect(exposed.status).toBe(200);

    const notExposed = await GET(
      makeReq("/api/content/shop/secret", { token: raw }),
      params("shop", "secret"),
    );
    expect(notExposed.status).toBe(403);
    expect((await notExposed.json()) as { error: string }).toEqual({
      error: "not_exposed",
    });

    // blog 未宣告 customApiRoutes → 該 published type 可讀。
    await seedBlog();
    const undeclared = await GET(
      makeReq("/api/content/blog/post", { token: raw }),
      params("blog", "post"),
    );
    expect(undeclared.status).toBe(200);
  });

  it("404 for a disabled ext or an undeclared content type", async () => {
    await seedBlog();
    const { raw } = await createApiToken("ok");

    const unknownExt = await GET(
      makeReq("/api/content/nope/post", { token: raw }),
      params("nope", "post"),
    );
    expect(unknownExt.status).toBe(404);

    const unknownType = await GET(
      makeReq("/api/content/blog/nope", { token: raw }),
      params("blog", "nope"),
    );
    expect(unknownType.status).toBe(404);
  });
});

// ---- §6.6:revoke 後該 token → 401 ----

describe("revoke (§6.6)", () => {
  it("revoked token → 401", async () => {
    await seedBlog();
    const { raw, id } = await createApiToken("ok");

    const before = await GET(
      makeReq("/api/content/blog/post", { token: raw }),
      params("blog", "post"),
    );
    expect(before.status).toBe(200);

    await revokeApiToken(id);

    // authenticateApiToken 直接回 null。
    expect(await authenticateApiToken(makeReq("/api/content/blog/post", { token: raw }))).toBeNull();

    const after = await GET(
      makeReq("/api/content/blog/post", { token: raw }),
      params("blog", "post"),
    );
    expect(after.status).toBe(401);
  });
});

// ---- §6.7:CORE_API 1.9.0;customApiRoutes ^1.9.0 可裝;read-only gate ----

describe("core api 1.9.0 + manifest gate (§6.7)", () => {
  it("CORE_API_VERSION is 1.25.0 (still ^1.9.0-compatible: same major, newer minor)", () => {
    expect(CORE_API_VERSION).toBe("1.25.0");
  });

  it("manifest with GET customApiRoutes + ^1.9.0 parses", () => {
    const r = parseManifest({
      kind: "declarative",
      id: "shop",
      name: "Shop",
      version: "1.0.0",
      coreApi: "^1.9.0",
      contentTypes: [{ name: "product", fields: [{ key: "title", type: "text" }] }],
      customApiRoutes: [{ method: "GET", path: "/p", contentType: "product" }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects non-GET customApiRoutes (read-only v1)", () => {
    const r = parseManifest({
      kind: "declarative",
      id: "shop",
      name: "Shop",
      version: "1.0.0",
      coreApi: "^1.9.0",
      customApiRoutes: [{ method: "POST", path: "/p" }],
    });
    expect(r.ok).toBe(false);
  });

  it("coreApi gate: this core installs ^1.9.0; a 1.8.0 core would not", () => {
    expect(satisfies(CORE_API_VERSION, "^1.9.0")).toBe(true);
    expect(satisfies("1.8.0", "^1.9.0")).toBe(false);
  });
});
