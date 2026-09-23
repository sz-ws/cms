import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// GET /api/registry/index 的 binding-backed 整合測試(miniflare D1)。
// 同既有測試(search.test.ts 等):mock @/lib/cf 讓 db()/getDB() 直接打到
// cloudflare:test 的 env.DB;mock @/lib/auth 讓 requireAuth 由測試控制。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role)
        throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// registry.json 抓取全 mock(避免真的打網路)——entries 由每個測試自行指定。
const registryState = vi.hoisted(() => ({
  entries: [] as unknown[],
  errors: [] as unknown[],
}));
vi.mock("@/lib/registry-client", () => ({
  fetchRegistryIndex: async () => ({
    entries: registryState.entries,
    errors: registryState.errors,
  }),
}));

// @/ext/loader 全 mock(workers pool 地雷:loader 的相依鏈含 next/navigation,
// 靜態 import 會拖垮 test pool——見 ext-jobs.test.ts 同款註解)。rt.all 由每個
// 測試自行指定,模擬「這次部署編譯進 bundle 的 code extensions」。
const rtState = vi.hoisted(() => ({ all: [] as Extension[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  const rt = {
    enabled: [] as Extension[],
    get all() {
      return rtState.all;
    },
    hooks,
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { GET } from "../src/app/api/registry/index/route";
import { overrideRegistry } from "../src/ext/overrides";
import { surfaceIds } from "../src/ext/dx/surfaces";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

const EXT_DDL =
  "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const DX_DDL =
  "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);";

beforeAll(async () => {
  await d1().exec(EXT_DDL);
  await d1().exec(DX_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions;");
  await d1().exec("DELETE FROM declarative_extensions;");
  authState.user = null;
  registryState.entries = [];
  registryState.errors = [];
  rtState.all = [];
});

async function insertExt(
  id: string,
  enabled: number,
  version: string,
): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, enabled, version, now, now)
    .run();
}

function fakeExt(id: string, version: string): Extension {
  return { id, name: id, version, coreApi: "^1.0.0" };
}

describe("GET /api/registry/index", () => {
  it("401 when unauthenticated", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("403 for a non-admin session", async () => {
    authState.user = EDITOR;
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("installedCode has one entry per bundle-compiled code extension, independent of registry.json entries", async () => {
    authState.user = ADMIN;
    // "cron" 有 DB 列(enabled=1,但 DB 版本落後於 bundle 版本 —— 模擬「已安裝但
    // 有更新」)。"other-code" 編譯進 bundle 但從未寫入 DB 列(模擬「新編譯進去、
    // 還沒 install/enable 過」)。
    await insertExt("cron", 1, "1.1.0");
    rtState.all = [fakeExt("cron", "1.2.0"), fakeExt("other-code", "0.9.0")];

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installedCode: { id: string; version: string; enabled: boolean }[];
    };
    expect(body.installedCode).toEqual([
      { id: "cron", version: "1.2.0", enabled: true },
      { id: "other-code", version: "0.9.0", enabled: false },
    ]);
  });

  it("marks an installed-but-disabled code extension as enabled:false", async () => {
    authState.user = ADMIN;
    await insertExt("cron", 0, "1.2.0");
    rtState.all = [fakeExt("cron", "1.2.0")];

    const res = await GET();
    const body = (await res.json()) as {
      installedCode: { id: string; version: string; enabled: boolean }[];
    };
    expect(body.installedCode).toEqual([
      { id: "cron", version: "1.2.0", enabled: false },
    ]);
  });

  it("installedCode is empty when no code extensions are compiled into the bundle", async () => {
    authState.user = ADMIN;
    rtState.all = [];

    const res = await GET();
    const body = (await res.json()) as { installedCode: unknown[] };
    expect(body.installedCode).toEqual([]);
  });

  it("does not change the existing entries/errors/services response shape", async () => {
    authState.user = ADMIN;
    registryState.entries = [
      {
        id: "cron",
        kind: "code",
        name: "Cron",
        version: "1.2.0",
        coreApi: "^1.0.0",
        source: "https://example.test",
      },
    ];
    rtState.all = [fakeExt("cron", "1.2.0")];

    const res = await GET();
    const body = (await res.json()) as {
      entries: { id: string; installed: boolean; installedVersion: string | null }[];
      errors: unknown[];
      services: unknown[];
      installedCode: unknown[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe("cron");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.installedCode)).toBe(true);
  });

  // 1.52.0:付費插件的 access / offer 與來源錯誤的狀態碼原樣帶給商店。
  it("passes access, offer and the source error status through", async () => {
    authState.user = ADMIN;
    const offer = { price: { amount: 25000, currency: "TWD", period: "year" } };
    registryState.entries = [
      { id: "replay", kind: "declarative", name: "Replay", version: "0.1.0", coreApi: "^1.0.0", source: "https://registry.example.com", access: "locked", offer },
    ];
    registryState.errors = [{ source: "https://other.example.com", error: "http 403", status: 403 }];
    const body = (await (await GET()).json()) as { entries: { access?: string; offer?: unknown }[]; errors: unknown[] };
    expect(body.entries[0]).toMatchObject({ access: "locked", offer });
    expect(body.errors).toEqual([{ source: "https://other.example.com", error: "http 403", status: 403 }]);
  });

  // 1.49.0:某個來源還列著 catalog(舊索引、別人的 registry)也不在商店出現。
  it("leaves the built-in catalog out of the store", async () => {
    authState.user = ADMIN;
    registryState.entries = [
      { id: "catalog", kind: "declarative", name: "Catalog", version: "0.2.0", coreApi: "^1.25.0", source: "https://example.test" },
      { id: "blog", kind: "declarative", name: "Blog", version: "1.2.5", coreApi: "^1.0.0", source: "https://example.test" },
    ];
    rtState.all = [];

    const body = (await (await GET()).json()) as { entries: { id: string }[] };
    expect(body.entries.map((e) => e.id)).toEqual(["blog"]);
  });

  // 1.51.0:這個站把宣告式插件的前台編進了網站 → 商店詳情不問核准,改顯示一句說明。
  it("marks a declarative entry whose scripts are compiled into this site", async () => {
    authState.user = ADMIN;
    if (!overrideRegistry.has("proof", surfaceIds.publicScripts())) {
      overrideRegistry.register("proof", surfaceIds.publicScripts(), "scripts", () => null);
    }
    registryState.entries = [
      { id: "proof", kind: "declarative", name: "Proof", version: "0.3.0", coreApi: "^1.51.0", source: "https://example.test" },
      { id: "blog", kind: "declarative", name: "Blog", version: "1.2.5", coreApi: "^1.0.0", source: "https://example.test" },
    ];

    const body = (await (await GET()).json()) as { entries: { id: string; scriptsCompiled?: boolean }[] };
    expect(body.entries.map((e) => [e.id, e.scriptsCompiled])).toEqual([
      ["proof", true],
      ["blog", undefined],
    ]);
  });
});

// 1.50.0:「已安裝」= 裝的就是這一個。1.52.0 起以 (來源, id) 為準:identity 不同是
// identity 衝突,別的來源一律是 source 衝突(沒有更新鈕)。
describe("GET /api/registry/index — plugin identity", () => {
  const A = "https://registry-a.test";
  const B = "https://registry-b.test";

  async function insertDx(id: string, source: string, identity?: string, enabled = 1) {
    const manifest = { kind: "declarative", id, name: { en: "Reviews", "zh-Hant": "評論" }, version: "1.0.0", coreApi: "^1.50.0", ...(identity ? { identity } : {}) };
    await d1()
      .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES (?, ?, '1.0.0', ?, ?, 1, 1)")
      .bind(id, JSON.stringify(manifest), enabled, source)
      .run();
  }

  const entry = (source: string, identity?: string) => ({
    id: "reviews",
    kind: "declarative",
    name: "Reviews",
    version: "1.1.0",
    coreApi: "^1.50.0",
    source,
    ...(identity ? { identity } : {}),
  });

  type Body = {
    entries: { source: string; installed: boolean; installedVersion: string | null; conflict: string | null; installedSource: string | null }[];
    installedPlugins: { id: string; kind: string; enabled: boolean; identity: string | null; name: unknown }[];
  };

  it("an entry with a different identity is a conflict, the same identity from another source is a source conflict", async () => {
    authState.user = ADMIN;
    await insertDx("reviews", A, "acme/reviews");
    registryState.entries = [entry(A, "acme/reviews"), entry(B, "other/reviews"), entry(B + "/mirror", "acme/reviews")];
    const body = (await (await GET()).json()) as Body;
    expect(body.entries.map((e) => [e.installed, e.installedVersion, e.conflict, e.installedSource])).toEqual([
      [true, "1.0.0", null, null],
      [false, null, "identity", null],
      [false, null, "source", A],
    ]);
  });

  it("an install from before identities is only this entry when the source matches", async () => {
    authState.user = ADMIN;
    await insertDx("reviews", A);
    registryState.entries = [entry(A), entry(B, "acme/reviews")];
    const body = (await (await GET()).json()) as Body;
    expect(body.entries[0]).toMatchObject({ installed: true, conflict: null });
    expect(body.entries[1]).toMatchObject({ installed: false, conflict: "source", installedSource: A });
  });

  // 索引常落後 manifest(registry 的索引建置還沒帶 identity、第三方來源):索引沒寫
  // identity 不能讓已安裝、有 identity 的插件變成「跟自己衝突」。
  it("an entry whose index has no identity is judged by source, not as a different plugin", async () => {
    authState.user = ADMIN;
    await insertDx("reviews", A, "acme/reviews");
    registryState.entries = [entry(A), entry(B)];
    const body = (await (await GET()).json()) as Body;
    expect(body.entries[0]).toMatchObject({ installed: true, installedVersion: "1.0.0", conflict: null });
    expect(body.entries[1]).toMatchObject({ installed: false, conflict: "source", installedSource: A });
  });

  it("an id taken by the other kind is a conflict", async () => {
    authState.user = ADMIN;
    rtState.all = [fakeExt("reviews", "2.0.0")];
    registryState.entries = [entry(A)];
    const body = (await (await GET()).json()) as Body;
    expect(body.entries[0]).toMatchObject({ installed: false, conflict: "kind" });
  });

  it("a compiled-in code plugin supplies its own requiresExtensions when the index has none", async () => {
    authState.user = ADMIN;
    rtState.all = [{ ...fakeExt("bundles", "1.0.0"), requiresExtensions: ["stock"] }];
    registryState.entries = [
      { id: "bundles", kind: "code", name: "Bundles", version: "1.0.0", coreApi: "^1.36.0", source: A },
      { id: "loyalty", kind: "code", name: "Loyalty", version: "1.0.0", coreApi: "^1.36.0", source: A, requiresExtensions: [{ id: "stock", optional: true }] },
    ];
    const body = (await (await GET()).json()) as { entries: { id: string; requiresExtensions?: unknown }[] };
    expect(body.entries[0].requiresExtensions).toEqual([{ id: "stock" }]);
    expect(body.entries[1].requiresExtensions).toEqual([{ id: "stock", optional: true }]);
  });

  it("installedPlugins lists both kinds with enabled state and identity", async () => {
    authState.user = ADMIN;
    await insertExt("shop", 1, "0.5.0");
    rtState.all = [{ ...fakeExt("shop", "0.5.0"), identity: "sz-ws/shop" }, fakeExt("cron", "1.0.0")];
    await insertDx("reviews", A, "acme/reviews", 0);
    const body = (await (await GET()).json()) as Body;
    expect(body.installedPlugins).toEqual([
      { id: "shop", kind: "code", enabled: true, identity: "sz-ws/shop", name: "shop" },
      { id: "cron", kind: "code", enabled: false, identity: null, name: "cron" },
      { id: "reviews", kind: "declarative", enabled: false, identity: "acme/reviews", name: { en: "Reviews", "zh-Hant": "評論" } },
    ]);
  });
});
