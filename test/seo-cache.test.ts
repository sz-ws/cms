import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// SEO 基礎(robots.txt / sitemap.xml / feed.xml)binding-backed 整合測試(miniflare
// D1)。同既有慣例:mock @/lib/cf 讓 db()/getDB() 打到 env.DB。settings 用 in-memory
// map mock(照 test/oidc.test.ts 的 precedent),繞開 getSetting → getExtRuntime →
// registry 這條與本測試無關的重鏈路,同時讓 getSetting 呼叫次數可數
// (驗證「TTL 內零 settings 讀」)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const settingsStore = vi.hoisted(() => new Map<string, unknown>());
const getSettingCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/settings", () => ({
  getSetting: async <T>(key: string, fallback?: T): Promise<T> => {
    getSettingCalls.count++;
    return settingsStore.has(key) ? (settingsStore.get(key) as T) : (fallback as T);
  },
}));

import {
  getSeoSnapshot,
  __clearSeoCache,
  SITEMAP_PAGE_SIZE,
} from "../src/ext/dx/seo-cache";
import { escapeXml } from "../src/ext/dx/seo-xml";
import { GET as sitemapIndex } from "../src/app/sitemap.xml/route";
import { GET as sitemapChild } from "../src/app/sitemap/[page]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const DX_DDL =
  "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(DX_DDL);
  await d1().exec(CONTENTS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM contents;");
  settingsStore.clear();
  getSettingCalls.count = 0;
  __clearSeoCache();
});

const GALLERY_MANIFEST = {
  kind: "declarative",
  id: "gallery",
  name: "Gallery",
  version: "1.0.0",
  coreApi: "^1.11.0",
  contentTypes: [
    {
      name: "item",
      slugField: "title",
      fields: [
        { key: "title", type: "text", label: "Title" },
        { key: "body", type: "text" },
      ],
    },
  ],
  publicRoutes: [
    { pattern: "/gallery", view: "list", contentType: "item" },
    { pattern: "/gallery/:slug", view: "detail", contentType: "item" },
  ],
};

async function insertDx(id: string, manifest: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, stylesheet, installed_at, updated_at) VALUES (?, ?, '1.0.0', 1, NULL, NULL, ?, ?)",
    )
    .bind(id, JSON.stringify(manifest), now, now)
    .run();
}

async function insertContent(opts: {
  id: string;
  type: string;
  slug: string;
  status?: string;
  locale?: string;
  data: Record<string, unknown>;
  updatedAt: number;
  publishAt?: number | null;
}): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, locale, slug, status, publish_at, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      opts.id,
      opts.type,
      opts.locale ?? "en",
      opts.slug,
      opts.status ?? "published",
      opts.publishAt ?? null,
      JSON.stringify(opts.data),
      opts.updatedAt,
      opts.updatedAt,
    )
    .run();
}

async function insertPublishedRange(count: number): Promise<void> {
  for (let start = 0; start < count; start += 100) {
    const batch = [];
    for (let i = start; i < Math.min(start + 100, count); i++) {
      const id = `bulk-${String(i).padStart(5, "0")}`;
      batch.push(
        d1()
          .prepare(
            "INSERT INTO contents (id, type, locale, slug, status, publish_at, data, created_at, updated_at) VALUES (?, ?, 'en', ?, 'published', NULL, ?, ?, ?)",
          )
          .bind(id, "gallery.item", `item-${i}`, JSON.stringify({ title: `Item ${i}` }), 1, 1),
      );
    }
    await d1().batch(batch);
  }
}

describe("getSeoSnapshot", () => {
  it("lists published detail entries + the list route, skips drafts, and builds feed items newest-first", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    await insertContent({
      id: "e1",
      type: "gallery.item",
      slug: "first-post",
      data: { title: "First post", body: "hello" },
      updatedAt: 1000,
    });
    await insertContent({
      id: "e2",
      type: "gallery.item",
      slug: "second-post",
      data: { title: "Second post" },
      updatedAt: 2000,
      publishAt: 1500,
    });
    await insertContent({
      id: "e3",
      type: "gallery.item",
      slug: "draft-post",
      status: "draft",
      data: { title: "Draft" },
      updatedAt: 3000,
    });

    const snap = await getSeoSnapshot();

    const paths = snap.sitemapUrls.map((u) => u.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/gallery/first-post", "/gallery/second-post", "/gallery"]),
    );
    expect(paths).not.toContain("/gallery/draft-post");

    // newest updatedAt first; second-post's pubDate uses publishAt over updatedAt.
    expect(snap.feedItems).toEqual([
      { title: "Second post", path: "/gallery/second-post", pubDate: 1500 },
      { title: "First post", path: "/gallery/first-post", pubDate: 1000 },
    ]);
  });

  it("reflects core.seo.* flags and core.siteUrl from settings", async () => {
    settingsStore.set("core.seo.robots", false);
    settingsStore.set("core.seo.sitemap", false);
    settingsStore.set("core.seo.rss", false);
    settingsStore.set("core.siteUrl", "https://example.com");

    const snap = await getSeoSnapshot();
    expect(snap.robotsEnabled).toBe(false);
    expect(snap.sitemapEnabled).toBe(false);
    expect(snap.rssEnabled).toBe(false);
    expect(snap.siteUrl).toBe("https://example.com");
  });

  it("defaults all three publish flags to true when unset", async () => {
    const snap = await getSeoSnapshot();
    expect(snap.robotsEnabled).toBe(true);
    expect(snap.sitemapEnabled).toBe(true);
    expect(snap.rssEnabled).toBe(true);
  });

  it("caches the snapshot for the TTL window: repeat calls do zero additional settings reads and zero recompute", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    await insertContent({
      id: "e1",
      type: "gallery.item",
      slug: "first-post",
      data: { title: "First post" },
      updatedAt: 1000,
    });

    const first = await getSeoSnapshot();
    const callsAfterFirst = getSettingCalls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await getSeoSnapshot();
    // Referential equality is only possible on the cache-hit path (compute
    // always allocates a fresh object) — this proves no recompute happened,
    // which in turn proves zero contents/declarative_extensions queries.
    expect(second).toBe(first);
    expect(getSettingCalls.count).toBe(callsAfterFirst);
  });

  it("recomputes immediately after __clearSeoCache()", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    const first = await getSeoSnapshot();
    const callsAfterFirst = getSettingCalls.count;

    __clearSeoCache();
    const second = await getSeoSnapshot();
    expect(second).not.toBe(first);
    expect(getSettingCalls.count).toBeGreaterThan(callsAfterFirst);
  });

  it("recomputes once the TTL window has elapsed", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      const first = await getSeoSnapshot();

      nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 - 1);
      const withinTtl = await getSeoSnapshot();
      expect(withinTtl).toBe(first);

      nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
      const afterTtl = await getSeoSnapshot();
      expect(afterTtl).not.toBe(first);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("skips list routes whose pattern has a param segment (nothing to substitute for a sitemap URL)", async () => {
    await insertDx("gallery", {
      ...GALLERY_MANIFEST,
      publicRoutes: [
        { pattern: "/gallery/:category", view: "list", contentType: "item" },
        { pattern: "/gallery/:slug", view: "detail", contentType: "item" },
      ],
    });
    const snap = await getSeoSnapshot();
    expect(snap.sitemapUrls.some((u) => u.path.includes(":"))).toBe(false);
  });

  it("deduplicates the one public sitemap URL shared by two locale rows", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    await insertContent({
      id: "en-about",
      type: "gallery.item",
      locale: "en",
      slug: "about",
      data: { title: "About" },
      updatedAt: 1000,
    });
    await insertContent({
      id: "zh-about",
      type: "gallery.item",
      locale: "zh-Hant",
      slug: "about",
      data: { title: "關於" },
      updatedAt: 2000,
    });

    const urls = (await getSeoSnapshot()).sitemapUrls.filter(
      (url) => url.path === "/gallery/about",
    );
    expect(urls).toEqual([{ path: "/gallery/about", lastModified: 2000 }]);
  });

  it("serves a sitemap index whose reachable child pages cover every published URL", async () => {
    await insertDx("gallery", GALLERY_MANIFEST);
    await insertPublishedRange(SITEMAP_PAGE_SIZE + 1);
    settingsStore.set("core.siteUrl", "https://cms.test");

    const index = await sitemapIndex();
    const indexXml = await index.text();
    const childLocs = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(childLocs).toEqual([
      "https://cms.test/sitemap/0.xml",
      "https://cms.test/sitemap/1.xml",
    ]);

    const childXml = await Promise.all(
      childLocs.map(async (loc) => {
        const page = loc.match(/\/(\d+\.xml)$/)?.[1];
        expect(page).toBeTruthy();
        const response = await sitemapChild(new Request(loc), {
          params: Promise.resolve({ page: page! }),
        });
        expect(response.status).toBe(200);
        return response.text();
      }),
    );
    const urls = childXml.flatMap((xml) =>
      [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    );

    // 10,001 detail pages + the static /gallery list route; no gaps or duplicate URLs.
    expect(urls).toHaveLength(SITEMAP_PAGE_SIZE + 2);
    expect(new Set(urls).size).toBe(SITEMAP_PAGE_SIZE + 2);
    expect(urls).toContain("https://cms.test/gallery/item-0");
    expect(urls).toContain("https://cms.test/gallery/item-10000");
    expect(urls).toContain("https://cms.test/gallery");
  });
});

describe("escapeXml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes all five reserved XML characters", () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's "quote"</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s &quot;quote&quot;&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("Hello world")).toBe("Hello world");
  });
});
