import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// 冷啟動的 D1 來回次數(一個公開頁 GET,在一個剛起來的 isolate 上)。
//
// 暖的 isolate 靠 memo 與 KV 的戳副本一趟 D1 都不打;冷的 isolate 的 memo 全是空的,以前
// middleware 為了 CSP 白名單一趟、頁面為了設定、啟用的 code extension、內建插件的列、
// 啟用的宣告式插件各一趟(沒有 KV 的站再加兩趟戳),而且大多一趟等一趟。這裡數的是
// **來回**:一次 first/all/run/raw 算一趟,一個 batch 不論幾條 SQL 也算一趟。
//
// 每個測試都是一個新的 isolate:vi.resetModules() 之後重新 import,所有 module 級的
// memo 都是空的(vi.mock 的替身不受影響)。

interface Trips {
  n: number;
  log: string[];
}
const trips = vi.hoisted((): Trips => ({ n: 0, log: [] }));
const cfState = vi.hoisted(() => ({
  context: null as null | { env: Record<string, unknown>; ctx?: { waitUntil(p: Promise<unknown>): void } },
}));
const headerState = vi.hoisted(() => ({ publicPage: true }));
/** 目前是第幾個請求:下面的 react cache 替身以它為範圍。 */
const requestScope = vi.hoisted(() => ({ id: 0 }));

// prepare 出來的 statement 包一層,batch 前換回原物件(原生的 batch 只收原生的 statement)。
const originals = new WeakMap<object, D1PreparedStatement>();

function countStatement(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") {
        return (...values: unknown[]) => countStatement(target.bind(...values), sql);
      }
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        return (...args: unknown[]) => {
          trips.n += 1;
          trips.log.push(sql.replace(/\s+/g, " ").slice(0, 70));
          return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  originals.set(wrapped, stmt);
  return wrapped;
}

function countingD1(): D1Database {
  const real = (env as { DB: D1Database }).DB;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => countStatement(target.prepare(sql), sql);
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          trips.n += 1;
          trips.log.push(`batch(${statements.length})`);
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => countingD1(),
  getStorage: () => undefined,
}));

vi.mock("@opennextjs/cloudflare/cloudflare-context", () => ({
  getCloudflareContext: () => {
    if (!cfState.context) throw new Error("getCloudflareContext has been called outside a request");
    return cfState.context;
  },
}));

// React 的 cache() 在正式站是「一個請求一份」(RSC 渲染期間);測試裡沒有渲染,真的 cache
// 什麼都不存。這裡換成以 requestScope 為範圍的替身,一個請求裡戳、整包設定、runtime 各算
// 一次 —— 與正式站相同,數出來的來回次數才是正式站的次數。只用在零參數的函式上。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <R,>(fn: () => R) => {
      let memo: { id: number; value: R } | null = null;
      return () => {
        if (memo && memo.id === requestScope.id) return memo.value;
        const value = fn();
        memo = { id: requestScope.id, value };
        return value;
      };
    },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.publicPage ? { "x-cms-public-page": "1" } : {}),
}));

// 這裡不會有 Next 的控制訊號要往回丟;真的 next/navigation 在 workers 測試池裡一載入就炸。
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

// 一個啟用中的 code extension「shop」:它讓內建的商品目錄(commerce-kit)成為應有的,
// loader 的完整載入因此會走內建插件的對齊。interpret 不載 view(同 request-stamps-kv)。
vi.mock("@/../extensions/registry", () => ({
  registry: [{ id: "shop", name: "Shop", version: "1.0.0", coreApi: "^1.0.0" }] as unknown as Extension[],
}));
vi.mock("@/ext/dx/interpret", () => ({ interpretManifest: () => ({ status: "invalid" as const }) }));

import { NextRequest } from "next/server";
import { catalogManifest } from "../src/ext/commerce-kit/catalog";
import { hashScripts } from "../src/ext/dx/scripts-core";
import { readStampsRecordFromD1 } from "../src/lib/stamps";

const d1 = () => (env as { DB: D1Database }).DB;

class FakeKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

let pending: Promise<unknown>[] = [];

function bind(kv: FakeKv | null): void {
  cfState.context = {
    env: { DB: countingD1(), ...(kv ? { CMS_KV: kv } : {}) },
    ctx: { waitUntil: (p) => void pending.push(p) },
  };
}

async function settle(): Promise<void> {
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

/** 一個剛起來的 isolate:全新的 module(memo 全空)。 */
async function coldIsolate() {
  vi.resetModules();
  const [middleware, settings, loader, provider, hooks] = await Promise.all([
    import("../src/middleware"),
    import("../src/lib/settings"),
    import("../src/ext/loader"),
    import("../src/ext/dx/content-provider"),
    import("../src/ext/hooks"),
  ]);
  return {
    middleware: middleware.middleware,
    getPlainSetting: settings.getPlainSetting,
    getExtRuntime: loader.getExtRuntime,
    invalidateSettingsCache: settings.invalidateSettingsCache,
    contents: () => new provider.CoreContentProvider(new hooks.HookBus()),
  };
}

type Isolate = Awaited<ReturnType<typeof coldIsolate>>;

/**
 * 一個公開頁 GET,照正式站的順序:middleware(CSP 白名單)→ 頁面(整包設定 + extension
 * runtime,兩者同時開始,像 root layout 與 (site)/layout 那樣)。回傳頁面拿到的東西。
 */
async function publicPageGet(isolate: Isolate) {
  requestScope.id += 1;
  const res = await isolate.middleware(new NextRequest("https://site.test/"));
  const [title, runtime] = await Promise.all([
    isolate.getPlainSetting<string>("core.siteTitle"),
    isolate.getExtRuntime(),
  ]);
  return { csp: res.headers.get("content-security-policy") ?? "", title, runtime };
}

const GA = [{ src: "https://www.googletagmanager.com/gtag/js" }];

async function seed(): Promise<void> {
  const approval = JSON.stringify({ hash: await hashScripts(GA), by: "a@t.co", at: 1 });
  const ga = JSON.stringify({ kind: "declarative", id: "ga", name: "ga", version: "1.0.0", coreApi: "^1.48.0", scripts: GA });
  // 內建的商品目錄已經對齊過(與底座這份一字不差):穩定狀態下的冷啟動不會寫任何東西。
  const catalog = catalogManifest();
  await d1().batch([
    d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.siteTitle', '\"Example Shop\"', 1700000000100)"),
    d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('shop', 1, '1.0.0', 1, 1700000000200)"),
    d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at, scripts_approval) VALUES ('ga', ?, '1.0.0', 1, NULL, 1, 1700000000300, ?)",
      )
      .bind(ga, approval),
    d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at, scripts_approval) VALUES ('catalog', ?, ?, 1, 'builtin', 1, 1700000000400, NULL)",
      )
      .bind(JSON.stringify(catalog), String(catalog.version)),
  ]);
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);" +
      "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM settings; DELETE FROM extensions; DELETE FROM declarative_extensions; DELETE FROM contents;");
  await seed();
  pending = [];
  headerState.publicPage = true;
  trips.n = 0;
  trips.log = [];
});

afterEach(async () => {
  await settle();
  cfState.context = null;
  vi.restoreAllMocks();
});

describe("a public page GET on a cold isolate", () => {
  it("with a fresh KV copy of the stamps: one D1 round trip for the whole request", async () => {
    const kv = new FakeKv();
    bind(kv);
    kv.store.set("cms:request-stamps:v1", JSON.stringify(await readStampsRecordFromD1(d1())));
    trips.n = 0;

    const page = await publicPageGet(await coldIsolate());
    expect(page.title).toBe("Example Shop");
    expect(page.runtime.byId("shop")?.id).toBe("shop");
    expect(page.csp).toContain("https://www.googletagmanager.com");
    // middleware 從 KV 的副本拿白名單(零趟);頁面的設定與 runtime 同一個 batch。
    expect(trips.log).toEqual(["batch(4)"]);
  });

  it("then a warm request makes no D1 query at all", async () => {
    const kv = new FakeKv();
    bind(kv);
    kv.store.set("cms:request-stamps:v1", JSON.stringify(await readStampsRecordFromD1(d1())));
    const isolate = await coldIsolate();
    await publicPageGet(isolate);
    trips.n = 0;
    trips.log = [];

    const page = await publicPageGet(isolate);
    expect(page.title).toBe("Example Shop");
    expect(trips.log).toEqual([]);
  });

  it("without KV: one round trip in the middleware and one for the page", async () => {
    bind(null);
    const page = await publicPageGet(await coldIsolate());
    expect(page.title).toBe("Example Shop");
    expect(page.runtime.byId("shop")?.id).toBe("shop");
    expect(page.csp).toContain("https://www.googletagmanager.com");
    // middleware:戳與白名單同一個 batch;頁面:戳、設定、runtime 同一個 batch。
    expect(trips.log).toEqual(["batch(2)", "batch(4)"]);
  });

  it("with a stale KV copy: refreshes it with the allowlist, still one batch per bundle", async () => {
    const kv = new FakeKv();
    bind(kv);
    kv.store.set(
      "cms:request-stamps:v1",
      JSON.stringify({ ...(await readStampsRecordFromD1(d1())), at: Date.now() - 10 * 60_000 }),
    );
    trips.n = 0;
    const page = await publicPageGet(await coldIsolate());
    expect(page.title).toBe("Example Shop");
    expect(trips.log).toEqual(["batch(2)", "batch(4)"]);
    await settle();
    const written = JSON.parse(kv.store.get("cms:request-stamps:v1") ?? "{}") as { hosts?: string[]; at: number };
    expect(written.hosts).toEqual(["www.googletagmanager.com"]);
    expect(Date.now() - written.at).toBeLessThan(60_000);
  });
});

describe("the cold read never serves data that does not match the request's stamps", () => {
  it("a KV copy that has not caught up with a write: the page still reads the new value", async () => {
    const kv = new FakeKv();
    bind(kv);
    kv.store.set("cms:request-stamps:v1", JSON.stringify(await readStampsRecordFromD1(d1())));
    // 別的機房剛寫入,KV 的副本還沒換(其他機房約 60 秒後才看得到)。
    await d1().prepare("UPDATE settings SET value = '\"New\"', updated_at = 1700000009000 WHERE key = 'core.siteTitle'").run();

    const page = await publicPageGet(await coldIsolate());
    // 合併讀取的戳對不上 KV 的戳 → 不用它的設定,照舊自己查:讀到的是新值。
    expect(page.title).toBe("New");
  });

  it("a write during the cold read (invalidate) makes both memos read for themselves", async () => {
    bind(null);
    const isolate = await coldIsolate();
    const title = isolate.getPlainSetting<string>("core.siteTitle");
    isolate.invalidateSettingsCache(); // 同一個 isolate 的寫入路徑
    expect(await title).toBe("Example Shop");
    const again = trips.log.length;
    await isolate.getExtRuntime();
    // runtime 沒有拿那份被丟掉的讀取:自己查(啟用的 code extension、內建插件的列、啟用的宣告式插件)。
    expect(trips.log.length - again).toBeGreaterThanOrEqual(3);
  });

  it("a built-in plugin that needs re-aligning is written, then its rows are read again", async () => {
    await d1().prepare("DELETE FROM declarative_extensions WHERE id = 'catalog'").run();
    bind(null);
    const isolate = await coldIsolate();
    const runtime = await isolate.getExtRuntime();
    expect(runtime.byId("shop")?.id).toBe("shop");
    const row = await d1().prepare("SELECT enabled, source FROM declarative_extensions WHERE id = 'catalog'").first();
    expect(row).toEqual({ enabled: 1, source: "builtin" });
    // 對齊寫了東西 → 啟用的宣告式插件從 D1 重讀,不用冷啟動讀到的那份(那時還沒有 catalog)。
    expect(trips.log.at(-1)).toMatch(/^select "id", "manifest", "version", "enabled", "scripts_approval", "up/);
  });
});

describe("content lists", () => {
  it("read a page of entries and the total in one round trip", async () => {
    bind(null);
    const isolate = await coldIsolate();
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, status, data, created_at, updated_at) VALUES ('a', 'blog.post', 'published', '{\"title\":\"A\"}', 1, 1), ('b', 'blog.post', 'published', '{\"title\":\"B\"}', 2, 2)",
      )
      .run();
    trips.log = [];
    const { items, total } = await isolate.contents().query("blog.post", {
      filter: { status: "published" },
      sort: { field: "createdAt", dir: "desc" },
      page: 1,
      perPage: 1,
    });
    expect(items.map((e) => e.id)).toEqual(["b"]);
    expect(total).toBe(2);
    expect(trips.log).toEqual(["batch(2)"]);
  });
});
