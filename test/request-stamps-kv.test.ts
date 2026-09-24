import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// 版本戳的 Workers KV 副本(src/lib/stamps.ts):
//   - KV 與 D1 算出來的戳一字不差(memo 以字串比對新鮮度)
//   - middleware 認證過的公開頁 GET 用 KV;副本夠新 + memo 暖 → 一趟 D1 都不打
//   - 副本沒有 / 壞了 / 太舊 → 照舊打 D1,並在 waitUntil 裡寫回;KV 讀不到 → D1、不寫
//   - 後台、/api、不在 request 裡 → 一律 D1,就算 KV 裡有副本
//   - invalidate* 發布新戳;沒綁 KV、沒有 request context、KV 壞掉都不 throw
//   - 沒綁 KV → 與以前一模一樣(既有的 request-stamps / settings / loader / public-csp 測試照跑)
//
// 真 D1(miniflare),外面包一層計數;KV 用記憶體假物件(要能數讀寫、塞壞資料、模擬失敗)。

const counter = vi.hoisted(() => ({ prepares: 0 }));
const cfState = vi.hoisted(() => ({
  context: null as null | { env: Record<string, unknown>; ctx?: { waitUntil(p: Promise<unknown>): void } },
}));
const headerState = vi.hoisted(() => ({
  mode: "public" as "public" | "none" | "real" | "throw",
  error: null as unknown,
  calls: 0,
}));

function countingD1(): D1Database {
  const real = (env as { DB: D1Database }).DB;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          counter.prepares += 1;
          return target.prepare(sql);
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
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@opennextjs/cloudflare/cloudflare-context", () => ({
  getCloudflareContext: () => {
    if (!cfState.context) throw new Error("getCloudflareContext has been called outside a request");
    return cfState.context;
  },
}));

vi.mock("next/headers", async (importActual) => {
  const actual = await importActual<typeof import("next/headers")>();
  return {
    headers: async () => {
      headerState.calls += 1;
      if (headerState.mode === "real") return actual.headers();
      if (headerState.mode === "throw") throw headerState.error;
      return new Headers(headerState.mode === "public" ? { "x-cms-public-page": "1" } : {});
    },
  };
});

// next/navigation 的 client 版在 workers 測試池裡一載入就炸;換成 RSC 實際拿到的那一份。
vi.mock("next/navigation", async () => ({
  unstable_rethrow: (await import("next/dist/client/components/unstable-rethrow.server")).unstable_rethrow,
}));

// loader 相依鏈的源頭(同 ext-runtime-safety.test.ts):registry 清空、interpret 不載 view。
vi.mock("@/../extensions/registry", () => ({ registry: [] as Extension[] }));
vi.mock("@/ext/dx/interpret", () => ({ interpretManifest: () => ({ status: "invalid" as const }) }));

import { NextRequest } from "next/server";
import { DynamicServerError } from "next/dist/client/components/hooks-server-context";
import {
  PUBLIC_PAGE_HEADER,
  SCRIPTS_STAMP_SQL,
  STAMPS_KV_KEY,
  STAMPS_MAX_AGE_MS,
  readStampsFromKv,
  readStampsRecordFromD1,
  scriptsStampFromRow,
  stripPublicPageHeader,
  type ScriptsStampRow,
  type StampsRecord,
} from "../src/lib/stamps";
import {
  computeSettingsStamp,
  getRequestStamps,
  publishRequestStamps,
} from "../src/lib/request-stamps";
import { computeExtRuntimeStamp } from "../src/ext/runtime-stamp";
import { getPlainSetting, invalidateSettingsCache } from "../src/lib/settings";
import { cachedApprovedScriptHosts } from "../src/lib/public-csp";
import { middleware } from "../src/middleware";

type LoaderModule = typeof import("../src/ext/loader");
let loader: LoaderModule;
const getLoader = async () => (loader ??= await import("../src/ext/loader"));

const d1 = () => (env as { DB: D1Database }).DB;

class FakeKv {
  store = new Map<string, string>();
  gets = 0;
  puts: StampsRecord[] = [];
  deletes = 0;
  failGet = false;
  failPut = false;
  /** put 要花多久(模擬還在路上的寫入)。 */
  putDelay = 0;

  async get(key: string): Promise<string | null> {
    this.gets += 1;
    if (this.failGet) throw new Error("KV GET failed: 500");
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.putDelay > 0) await new Promise((resolve) => setTimeout(resolve, this.putDelay));
    if (this.failPut) throw new Error("KV PUT failed: 429 Too Many Requests");
    this.puts.push(JSON.parse(value) as StampsRecord);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.store.delete(key);
  }

  record(): StampsRecord | null {
    const raw = this.store.get(STAMPS_KV_KEY);
    return raw ? (JSON.parse(raw) as StampsRecord) : null;
  }

  seed(record: StampsRecord): void {
    this.store.set(STAMPS_KV_KEY, JSON.stringify(record));
  }
}

let pending: Promise<unknown>[] = [];

/** middleware 傳給 cachedApprovedScriptHosts 的那一份。 */
const target = (kv: FakeKv) => ({
  kv: kv as unknown as KVNamespace,
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
});

/** 綁上這個請求的 context。kv = null → 有 context、沒綁 CMS_KV。 */
function bind(kv: FakeKv | null): FakeKv | null {
  cfState.context = {
    env: { DB: countingD1(), ...(kv ? { CMS_KV: kv } : {}) },
    ctx: { waitUntil: (p) => void pending.push(p) },
  };
  return kv;
}

/** 等 waitUntil 裡的背景工作全部跑完(背景工作可能再排新的)。 */
async function settle(): Promise<void> {
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

async function freshRecord(): Promise<StampsRecord> {
  return readStampsRecordFromD1(d1());
}

async function seedRows(): Promise<void> {
  await d1().batch([
    d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.siteTitle', '\"A\"', 1700000000123)"),
    d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.locale', '\"en\"', 1700000000456)"),
    d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('shop', 1, '1.0.0', 1, 1700000000789)"),
    d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('cron', 0, '1.0.0', 1, 1700000000001)"),
    d1().prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES ('gallery', '{}', '1.0.0', 1, NULL, 1, 1700000000999)"),
  ]);
}

let clock = Date.UTC(2026, 8, 1);

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
});

beforeEach(async () => {
  // 讀的一方補寫 KV 有每個 isolate 10 秒的節流:每個測試把時鐘往前撥一分鐘。
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 60_000;
  vi.setSystemTime(clock);

  cfState.context = null;
  invalidateSettingsCache();
  (await getLoader()).invalidateExtRuntimeMemo();
  pending = [];
  headerState.mode = "public";
  headerState.error = null;
  headerState.calls = 0;
  await d1().exec("DELETE FROM settings; DELETE FROM extensions; DELETE FROM declarative_extensions;");
  await seedRows();
  counter.prepares = 0;
});

afterEach(async () => {
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stamp formats", () => {
  it("KV and D1 hold the exact same strings for the same database state", async () => {
    const record = await freshRecord();
    expect(record.settings).toBe(await computeSettingsStamp());
    expect(record.extensions).toBe(await computeExtRuntimeStamp());
    const scriptsRow = await d1().prepare(SCRIPTS_STAMP_SQL).first<ScriptsStampRow>();
    expect(record.scripts).toBe(scriptsStampFromRow(scriptsRow));
    expect(record).toMatchObject({
      settings: "2:1700000000456",
      extensions: "2:1700000000789:1|1:1700000000999:1",
      scripts: "1:1700000000999:1",
    });

    // 發布到 KV、再以公開頁的身分讀回來:與 D1 那條路回傳的物件完全相同。
    const kv = bind(new FakeKv())!;
    publishRequestStamps();
    await settle();
    expect(await readStampsFromKv(kv as unknown as KVNamespace)).toEqual({
      state: "fresh",
      stamps: { settings: record.settings, extensions: record.extensions, scripts: record.scripts },
    });
    const fromKv = await getRequestStamps();
    headerState.mode = "none";
    const fromD1 = await getRequestStamps();
    expect(fromKv).toEqual(fromD1);
  });
});

describe("public page requests", () => {
  it("take fresh stamps from KV: a warm isolate makes no D1 query at all", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed(await freshRecord());

    // 第一個請求:memo 是冷的,讀一次完整資料(D1),存進以 KV 戳為鍵的 memo。
    expect(await getPlainSetting("core.siteTitle")).toBe("A");
    const rt = await (await getLoader()).getExtRuntime();
    expect(rt.enabled).toEqual([]);
    expect(await cachedApprovedScriptHosts(countingD1(), target(kv))).toEqual([]);

    counter.prepares = 0;
    // 之後的請求:戳從 KV 來、memo 對得上 → 零 D1。
    expect(await getPlainSetting("core.siteTitle")).toBe("A");
    await (await getLoader()).getExtRuntime();
    expect(await cachedApprovedScriptHosts(countingD1(), target(kv))).toEqual([]);
    expect(await getRequestStamps()).toEqual({
      settings: { ok: true, stamp: "2:1700000000456" },
      extensions: { ok: true, stamp: "2:1700000000789:1|1:1700000000999:1" },
    });
    expect(counter.prepares).toBe(0);
    expect(kv.puts).toEqual([]);
  });

  it("see a write made elsewhere as soon as its stamps are published", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed(await freshRecord());
    expect(await getPlainSetting("core.siteTitle")).toBe("A");

    // 另一個 isolate 寫入(這裡的 memo 沒被清):KV 還是舊戳 → 照舊用 memo。
    await d1().prepare("UPDATE settings SET value = '\"B\"', updated_at = 1700000001000 WHERE key = 'core.siteTitle'").run();
    expect(await getPlainSetting("core.siteTitle")).toBe("A");

    // 寫入的一方發布新戳 → 下一個公開頁請求就讀到新值。
    publishRequestStamps();
    await settle();
    expect(kv.record()?.settings).toBe("2:1700000001000");
    expect(await getPlainSetting("core.siteTitle")).toBe("B");
  });

  const copies: [string, (kv: FakeKv, truth: StampsRecord) => void][] = [
    ["missing", () => {}],
    ["unparseable", (kv) => void kv.store.set(STAMPS_KV_KEY, "{not json")],
    // extensions 的後半與 scripts 對不上:不是我們寫的。
    ["the wrong shape", (kv, truth) => kv.seed({ ...truth, scripts: "9:9:9" })],
    ["older than the max age", (kv, truth) => kv.seed({ ...truth, settings: "9:9", at: Date.now() - STAMPS_MAX_AGE_MS })],
    ["from the future", (kv, truth) => kv.seed({ ...truth, settings: "9:9", at: Date.now() + STAMPS_MAX_AGE_MS })],
  ];

  it.each(copies)("fall back to D1 and write the stamps back when the KV copy is %s", async (_label, seed) => {
    const kv = bind(new FakeKv())!;
    const truth = await freshRecord();
    seed(kv, truth);
    counter.prepares = 0;

    const stamps = await getRequestStamps();
    expect(stamps.settings).toEqual({ ok: true, stamp: truth.settings });
    expect(stamps.extensions).toEqual({ ok: true, stamp: truth.extensions });
    expect(counter.prepares).toBe(1); // 一趟合併查詢,與沒有 KV 時一樣

    expect(pending).toHaveLength(1);
    await settle();
    expect(kv.puts).toHaveLength(1);
    expect(kv.record()).toEqual({ ...truth, at: Date.now() });
  });

  it("write back at most once per isolate every few seconds", async () => {
    const kv = bind(new FakeKv())!;
    await getRequestStamps();
    await getRequestStamps();
    await settle();
    expect(kv.puts).toHaveLength(1);
  });

  it("read D1 without writing when KV itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = bind(new FakeKv())!;
    kv.failGet = true;
    const stamps = await getRequestStamps();
    expect(stamps.settings).toEqual({ ok: true, stamp: "2:1700000000456" });
    expect(pending).toHaveLength(0);
    expect(error).toHaveBeenCalledWith("[stamps] KV read failed; using D1", expect.any(Error));
  });
});

describe("requests that must read D1", () => {
  const bogus = (): StampsRecord => ({ settings: "9:9", extensions: "9:9:9|9:9:9", scripts: "9:9:9", at: Date.now() });

  it("admin pages and /api (no header from middleware) ignore a fresh KV copy", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed(bogus());
    headerState.mode = "none";
    const stamps = await getRequestStamps();
    expect(stamps.settings).toEqual({ ok: true, stamp: "2:1700000000456" });
    expect(kv.gets).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it("outside a request scope (headers() throws) reads D1", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed(bogus());
    headerState.mode = "real";
    const stamps = await getRequestStamps();
    expect(stamps.settings).toEqual({ ok: true, stamp: "2:1700000000456" });
    expect(kv.gets).toBe(0);
  });

  it("never swallows Next's dynamic-rendering signal", async () => {
    bind(new FakeKv());
    headerState.mode = "throw";
    headerState.error = new DynamicServerError("headers");
    await expect(getRequestStamps()).rejects.toBe(headerState.error);
  });

  it("without the binding: D1 exactly as before, headers() is never even read", async () => {
    bind(null);
    expect(await getRequestStamps()).toEqual({
      settings: { ok: true, stamp: "2:1700000000456" },
      extensions: { ok: true, stamp: "2:1700000000789:1|1:1700000000999:1" },
    });
    expect(headerState.calls).toBe(0);
    expect(counter.prepares).toBe(1);

    cfState.context = null; // 不在 request 裡(測試、cron)
    expect((await getRequestStamps()).settings).toEqual({ ok: true, stamp: "2:1700000000456" });
    expect(headerState.calls).toBe(0);
  });
});

describe("publishing after writes", () => {
  it("invalidateSettingsCache and invalidateExtRuntimeMemo publish the new stamps", async () => {
    const kv = bind(new FakeKv())!;
    await d1().prepare("UPDATE settings SET value = '\"C\"', updated_at = 1700000002000 WHERE key = 'core.siteTitle'").run();
    invalidateSettingsCache();
    await settle();
    expect(kv.record()).toEqual({ ...(await freshRecord()), at: Date.now() });
    expect(kv.record()?.settings).toBe("2:1700000002000");

    await d1().prepare("UPDATE extensions SET enabled = 1, updated_at = 1700000003000 WHERE id = 'cron'").run();
    (await getLoader()).invalidateExtRuntimeMemo();
    await settle();
    expect(kv.record()?.extensions).toBe("2:1700000003000:2|1:1700000000999:1");
  });

  it("a write that lands while a publish is still in flight is not lost, and bursts merge", async () => {
    const kv = bind(new FakeKv())!;
    kv.putDelay = 200; // 第一輪發布還在路上
    await d1().prepare("UPDATE settings SET updated_at = 1700000004000 WHERE key = 'core.locale'").run();
    invalidateSettingsCache();
    await d1().prepare("UPDATE declarative_extensions SET enabled = 0, updated_at = 1700000005000 WHERE id = 'gallery'").run();
    (await getLoader()).invalidateExtRuntimeMemo();
    invalidateSettingsCache();
    expect(pending).toHaveLength(1); // 三次 invalidate,一輪發布
    await settle();
    // 第一輪讀的 D1 可能早於第二筆寫入;跑完隔一秒再發一次,最後留下的涵蓋兩筆。
    expect(kv.puts).toHaveLength(2);
    expect(kv.record()).toMatchObject({
      settings: "2:1700000004000",
      scripts: "1:1700000005000:0",
    });
  });

  it("never throws: no binding, no request context, or a failing KV", async () => {
    bind(null);
    expect(() => invalidateSettingsCache()).not.toThrow();
    expect(pending).toHaveLength(0);

    cfState.context = null;
    expect(() => invalidateSettingsCache()).not.toThrow();
    expect(() => publishRequestStamps()).not.toThrow();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = bind(new FakeKv())!;
    kv.seed(await freshRecord());
    kv.failPut = true;
    expect(() => invalidateSettingsCache()).not.toThrow();
    await settle(); // 重試一次(隔一秒)仍失敗 → 刪掉副本,公開頁回去讀 D1
    expect(kv.deletes).toBe(1);
    expect(kv.record()).toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[stamps] could not publish request stamps to KV; dropping the copy",
      expect.any(Error),
    );
  });
});

describe("middleware", () => {
  const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    new NextRequest(`https://site.test${path}`, init);
  const forwarded = (res: Response) => ({
    value: res.headers.get(`x-middleware-request-${PUBLIC_PAGE_HEADER}`),
    listed: (res.headers.get("x-middleware-override-headers") ?? "").split(",").includes(PUBLIC_PAGE_HEADER),
  });

  it("marks public GET pages and takes the CSP allowlist stamp from KV (no D1 once warm)", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed(await freshRecord());
    expect(forwarded(await middleware(request("/products")))).toEqual({ value: "1", listed: true });
    counter.prepares = 0;
    const res = await middleware(request("/products"));
    expect(res.headers.get("content-security-policy")).toMatch(/'nonce-/);
    expect(counter.prepares).toBe(0);
    // client 端換頁一樣要渲染頁面,一樣蓋上。
    expect(forwarded(await middleware(request("/products", { headers: { rsc: "1" } })))).toEqual({
      value: "1",
      listed: true,
    });
  });

  it("refreshes a stale KV copy from D1 for the allowlist too", async () => {
    const kv = bind(new FakeKv())!;
    kv.seed({ ...(await freshRecord()), scripts: "0:0:0", extensions: "2:1700000000789:1|0:0:0", at: 0 });
    await middleware(request("/products"));
    await settle();
    expect(kv.record()).toEqual({ ...(await freshRecord()), at: Date.now() });
  });

  it("strips a header the browser sends itself, everywhere", async () => {
    bind(new FakeKv());
    const spoof = { headers: { [PUBLIC_PAGE_HEADER]: "1", cookie: "session=x" } };
    for (const path of ["/admin/settings", "/login", "/robots.txt"]) {
      expect(forwarded(await middleware(request(path, spoof)))).toEqual({ value: null, listed: false });
    }
    // server action(POST 到公開頁):讀 D1。
    expect(forwarded(await middleware(request("/products", { ...spoof, method: "POST" })))).toEqual({
      value: null,
      listed: false,
    });
    // 沒綁 KV 的站:公開頁也不蓋。
    bind(null);
    expect(forwarded(await middleware(request("/products", spoof)))).toEqual({ value: null, listed: false });
  });

  it("changes nothing for normal requests on a site without the binding", async () => {
    bind(null);
    const login = await middleware(request("/login"));
    expect(login.headers.get("x-middleware-override-headers")).toBeNull();
    const page = await middleware(request("/products"));
    expect(page.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(PUBLIC_PAGE_HEADER);
  });

  it("the Worker entry strips the header on paths the middleware never sees", async () => {
    const plain = new Request("https://site.test/api/settings");
    expect(stripPublicPageHeader(plain)).toBe(plain);
    const spoofed = new Request("https://site.test/api/settings", {
      method: "PUT",
      headers: { [PUBLIC_PAGE_HEADER]: "1", "content-type": "application/json" },
      body: '{"a":1}',
    });
    const clean = stripPublicPageHeader(spoofed);
    expect(clean.headers.has(PUBLIC_PAGE_HEADER)).toBe(false);
    expect(clean.headers.get("content-type")).toBe("application/json");
    expect(clean.method).toBe("PUT");
    expect(await clean.text()).toBe('{"a":1}');
  });
});
