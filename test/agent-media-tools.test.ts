import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.60.0:媒體庫的 agent tools(core.media.list / core.media.upload)與「帶著上傳的圖建立
// 商品」這條完整路徑。
//
// R2 不在 vitest.config 的 miniflare bindings 內:getStorage 換成假 bucket(同
// media-dimensions-storage.test.ts)。D1 是真的 —— 商品經真的 CoreContentProvider 寫進
// contents 表,registry 經真的 buildAgentToolRegistry 從 declarative_extensions 列組出來。
// 抓網址的 fetch 以 vi.stubGlobal 換掉:這裡驗的是**我們自己**的規則(轉址逐跳重驗、帳密、
// 私有位址、大小、看檔頭不看標頭),不是網路。

interface FakeObject {
  body: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

const bucketState = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
const store = () => bucketState.store as Map<string, FakeObject>;

const fakeBucket = {
  async put(
    key: string,
    value: ArrayBuffer | Blob,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const body = value instanceof Blob ? await value.arrayBuffer() : value;
    store().set(key, { body, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    return { key, size: body.byteLength, etag: `e-${store().size}` };
  },
  async list(opts?: { cursor?: string; limit?: number }) {
    // 真 R2 依 key 排序、一頁最多 limit 個;cursor 在這裡就是下一頁的起點。
    const all = [...store().entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: page.map(([key, o]) => ({
        key,
        size: o.body.byteLength,
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
      })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  },
};

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => fakeBucket,
  getAI: () => undefined,
}));
// 上傳後的統計快照失效需要 Next 的 request scope;只打樁這一支,內容的失效照舊。
vi.mock("@/ext/dx/cache-invalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ext/dx/cache-invalidate")>()),
  revalidateStorageIndex: () => {},
}));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return { getExtRuntime: async () => rt };
});

import { invokeAgentTool } from "../src/ext/agent-tools";
import type { AgentTool, AgentToolCtx, AgentToolResult } from "../src/ext/agent-tools";
import { buildAgentToolRegistry } from "../src/ext/agent-tools-runtime";
import { createServices } from "../src/ext/services";
import { putFile } from "../src/lib/storage";
import { isMediaKey } from "../src/ext/dx/media-key";
import { catalogManifest } from "../src/ext/commerce-kit/catalog";
import { decodeBase64Image, fetchRemoteImage } from "../src/lib/remote-image";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, scripts_approval TEXT);",
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  ]) {
    await d1().exec(sql);
  }
});

beforeEach(async () => {
  bucketState.store = new Map();
  for (const table of ["contents", "content_fts", "settings", "declarative_extensions", "content_revisions"]) {
    await d1().exec(`DELETE FROM ${table};`);
  }
  invalidateSettingsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setSetting(key: string, value: unknown): Promise<void> {
  await d1()
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
    .bind(key, JSON.stringify(value), Date.now())
    .run();
  invalidateSettingsCache();
}

// ---- fixtures ----

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** 最小合法 PNG 檔頭(尺寸嗅得出來)+ padding。 */
function png(w: number, h: number, padding = 256): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(33 + padding));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
  return bytes;
}

/** 最小 JPEG:SOI + SOF0(高、寬)。 */
function jpeg(w: number, h: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(64));
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff]);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function ctx(): Promise<AgentToolCtx> {
  return {
    user: { id: "u1", email: "admin@example.test", name: "Admin", role: "admin", avatarKey: null },
    services: await createServices("core"),
  } as unknown as AgentToolCtx;
}

async function tools(): Promise<Map<string, AgentTool>> {
  const registry = await buildAgentToolRegistry();
  return new Map(registry.list().map((tool) => [tool.name, tool]));
}

async function call(name: string, args: unknown): Promise<AgentToolResult> {
  const tool = (await tools()).get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return invokeAgentTool(tool, await ctx(), args);
}

function result<T>(res: AgentToolResult): T {
  if (!res.ok) throw new Error(`tool failed: ${res.error} ${res.issues?.join("; ") ?? ""}`);
  return res.result as T;
}

interface Uploaded {
  key: string;
  url: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  alt?: string;
}

type FetchCall = { url: string; init?: RequestInit };

/** 依網址回應的假 fetch;記下每一次呼叫。 */
function stubFetch(routes: Record<string, () => Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return calls;
}

// ============================================================ upload: base64

describe("core.media.upload from base64", () => {
  it("stores the image exactly like the admin uploader and returns the key image fields take", async () => {
    await setSetting("core.siteUrl", "https://www.example.com/");
    const res = await call("core.media.upload", { base64: base64(png(640, 480)), alt: "Sample product" });
    const up = result<Uploaded>(res);
    expect(up.key).toMatch(/^core\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.png$/);
    expect(isMediaKey(up.key)).toBe(true);
    expect(up).toMatchObject({ contentType: "image/png", width: 640, height: 480, alt: "Sample product" });
    expect(up.url).toBe(`https://www.example.com/api/files/${up.key}`);
    // 與 putFile 寫的是同一種物件:contentType、尺寸、alt 都在 metadata。
    expect(store().get(up.key)).toMatchObject({
      httpMetadata: { contentType: "image/png" },
      customMetadata: { w: "640", h: "480", alt: "Sample product" },
    });
  });

  it("accepts a data: URL and keeps the URL relative when no site address is set", async () => {
    const up = result<Uploaded>(await call("core.media.upload", { base64: `data:image/jpeg;base64,${base64(jpeg(300, 200))}` }));
    expect(up).toMatchObject({ contentType: "image/jpeg", width: 300, height: 200 });
    expect(up.key.endsWith(".jpg")).toBe(true);
    expect(up.url).toBe(`/api/files/${up.key}`);
  });

  it("refuses bytes that are not an image, whatever the data: URL claims", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const res = await call("core.media.upload", { base64: `data:image/png;base64,${base64(html)}` });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/^not_an_image/);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await call("core.media.upload", { base64: base64(svg) })).ok).toBe(false);
    expect(store().size).toBe(0);
  });

  it("refuses data over the size cap before decoding, and malformed base64", () => {
    expect(() => decodeBase64Image(base64(png(10, 10, 64)), 32)).toThrow(/^too_large/);
    expect(() => decodeBase64Image("not base64!!", 1024)).toThrow(/^invalid_base64/);
    expect(() => decodeBase64Image("data:image/png,rawbytes", 1024)).toThrow(/^invalid_base64/);
  });

  it("needs exactly one source", async () => {
    for (const args of [{}, { base64: base64(png(1, 1)), url: "https://cdn.example.com/a.png" }]) {
      expect(await call("core.media.upload", args)).toMatchObject({ ok: false, error: "invalid_args" });
    }
  });
});

// ============================================================ upload: url

describe("core.media.upload from a URL", () => {
  it("fetches server-side without following redirects blindly and trusts the bytes, not the header", async () => {
    const calls = stubFetch({
      "https://cdn.example.com/photos/a": () =>
        new Response(jpeg(1200, 800), { headers: { "content-type": "text/plain" } }),
    });
    const up = result<Uploaded>(await call("core.media.upload", { url: "https://cdn.example.com/photos/a", alt: "Front" }));
    expect(up).toMatchObject({ contentType: "image/jpeg", width: 1200, height: 800, alt: "Front" });
    expect(up.key.endsWith(".jpg")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("follows a public redirect, re-checking the next address", async () => {
    const calls = stubFetch({
      "https://short.example.com/x": () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/b.png" } }),
      "https://cdn.example.com/b.png": () => new Response(png(50, 60)),
    });
    const up = result<Uploaded>(await call("core.media.upload", { url: "https://short.example.com/x" }));
    expect(up).toMatchObject({ width: 50, height: 60 });
    expect(calls.map((c) => c.url)).toEqual(["https://short.example.com/x", "https://cdn.example.com/b.png"]);
  });

  it("refuses a redirect to a private or local address without fetching it", async () => {
    for (const location of ["http://127.0.0.1/admin.png", "http://169.254.169.254/latest", "http://[::1]/a.png", "http://user:pw@cdn.example.com/a.png"]) {
      const calls = stubFetch({
        "https://cdn.example.com/moved": () => new Response(null, { status: 301, headers: { location } }),
      });
      const res = await call("core.media.upload", { url: "https://cdn.example.com/moved" });
      expect(res.ok === false && res.error).toMatch(/^url_not_allowed/);
      expect(calls).toHaveLength(1);
    }
    expect(store().size).toBe(0);
  });

  it("refuses credentials, other schemes and private hosts before any request", async () => {
    const calls = stubFetch({});
    for (const url of [
      "https://user:secret@cdn.example.com/a.png",
      "https://token@cdn.example.com/a.png",
      "ftp://cdn.example.com/a.png",
      "file:///etc/passwd",
      "http://localhost/a.png",
      "http://printer.local/a.png",
      "http://10.1.2.3/a.png",
      "http://192.168.0.10/a.png",
      "http://2130706433/a.png",
      "http://intranet/a.png",
      "http://[fc00::1]/a.png",
    ]) {
      const res = await call("core.media.upload", { url });
      expect(res.ok === false && res.error, url).toMatch(/^url_not_allowed/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a page that is not an image even when it says image/png", async () => {
    stubFetch({
      "https://shop.example.com/item/1": () => new Response("<!doctype html><title>Item</title>", { headers: { "content-type": "image/png" } }),
    });
    const res = await call("core.media.upload", { url: "https://shop.example.com/item/1" });
    expect(res.ok === false && res.error).toMatch(/^not_an_image/);
    expect(store().size).toBe(0);
  });

  it("refuses a file over the cap, by its declared length or while reading it", async () => {
    stubFetch({
      "https://cdn.example.com/huge.png": () =>
        new Response(png(1, 1), { headers: { "content-length": String(26 * 1024 * 1024) } }),
    });
    const declared = await call("core.media.upload", { url: "https://cdn.example.com/huge.png" });
    expect(declared.ok === false && declared.error).toMatch(/^too_large/);

    // 沒有 Content-Length 的串流:讀到超過上限就中斷(上限縮小,免得測試真的吃 25 MB)。
    const chunks = [png(1, 1, 40), new Uint8Array(64)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const fetchImpl = (async () => new Response(stream)) as unknown as typeof fetch;
    await expect(fetchRemoteImage("https://cdn.example.com/stream.png", { maxBytes: 80, fetchImpl })).rejects.toThrow(/^too_large/);
    expect(store().size).toBe(0);
  });

  it("reports an HTTP error from the source", async () => {
    stubFetch({});
    const res = await call("core.media.upload", { url: "https://cdn.example.com/missing.png" });
    expect(res.ok === false && res.error).toMatch(/^fetch_failed: .*404/);
  });
});

// ============================================================ list

describe("core.media.list", () => {
  it("returns keys, URLs, sizes and alt text, filters by alt or key, and pages with a cursor", async () => {
    const a = await putFile("core", "a.png", new Blob([png(100, 50)]), "image/png", "Blue mug");
    const b = await putFile("core", "b.png", new Blob([png(20, 20)]), "image/png");
    await putFile("core", "c.pdf", new Blob([new Uint8Array(10)]), "application/pdf");

    const all = result<{ items: Uploaded[]; cursor: string | null }>(await call("core.media.list", {}));
    expect(all.items.map((i) => i.key).sort()).toEqual([a.key, b.key].sort());
    expect(all.cursor).toBeNull();
    expect(all.items.find((i) => i.key === a.key)).toMatchObject({ width: 100, height: 50, alt: "Blue mug", url: `/api/files/${a.key}` });

    const mug = result<{ items: Uploaded[] }>(await call("core.media.list", { query: "mug" }));
    expect(mug.items.map((i) => i.key)).toEqual([a.key]);

    const withPdf = result<{ items: Uploaded[] }>(await call("core.media.list", { imagesOnly: false }));
    expect(withPdf.items).toHaveLength(3);

    const first = result<{ items: Uploaded[]; cursor: string | null }>(await call("core.media.list", { limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.cursor).not.toBeNull();
    const second = result<{ items: Uploaded[]; cursor: string | null }>(
      await call("core.media.list", { limit: 1, cursor: first.cursor }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].key).not.toBe(first.items[0].key);
  });
});

// ============================================================ 完整商品

describe("a complete product with an uploaded photo, through the generated tools", () => {
  beforeEach(async () => {
    await d1()
      .prepare("INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES ('catalog', '1.0.0', ?1, 1)")
      .bind(JSON.stringify(catalogManifest()))
      .run();
    await setSetting("core.content.extraFields", {
      "catalog.product": [
        { key: "origin", label: "Origin", type: "text", public: true },
        { key: "featured", label: "Featured", type: "boolean", public: false },
      ],
    });
  });

  it("upload → category → create with image key and extra fields → read back → update one extra field", async () => {
    const byName = await tools();
    const create = byName.get("content.catalog_product.create")!;
    expect(create.description).toContain("core.media.upload");
    expect(create.description).toContain("image (media key)");
    expect(create.description).toContain("extra {origin: text, featured: boolean}");

    const photo = result<Uploaded>(await call("core.media.upload", { base64: base64(png(800, 800)), alt: "Sample product" }));
    const category = result<{ id: string }>(await call("content.catalog_category.create", { data: { name: "Gifts" } }));

    // 網址塞進圖片欄位:schema 當場退回,指向該用的 tool。
    const wrong = await call("content.catalog_product.create", { data: { name: "Sample product", image: photo.url } });
    expect(wrong).toMatchObject({ ok: false, error: "invalid_args" });

    const created = result<{ id: string; status: string; data: Record<string, unknown> }>(
      await call("content.catalog_product.create", {
        data: {
          name: "Sample product",
          price: 320,
          summary: "A short line",
          body: "Longer description.",
          category: category.id,
          image: photo.key,
          extra: { origin: "  Hillside  ", featured: true },
        },
        status: "published",
      }),
    );
    expect(created.status).toBe("published");

    const read = result<{ data: Record<string, unknown> }>(await call("content.catalog_product.get", { id: created.id }));
    expect(read.data).toMatchObject({
      name: "Sample product",
      price: 320,
      category: category.id,
      image: photo.key,
      extra: { origin: "Hillside", featured: true },
    });

    // 只改一個額外欄位:另一個保持原值;null 清掉那一格。
    result(await call("content.catalog_product.update", { id: created.id, data: { extra: { featured: null } } }));
    const after = result<{ data: Record<string, unknown> }>(await call("content.catalog_product.get", { id: created.id }));
    expect(after.data.extra).toEqual({ origin: "Hillside" });
    expect(after.data.image).toBe(photo.key);
  });
});
