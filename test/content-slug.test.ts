import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// CoreContentProvider 的 slug 寫入路徑(binding-backed,miniflare D1):中文標題存得出
// 可讀 slug、撞號時的 -2 / -3 後綴照樣運作、getBySlug 用同一個字串查得到,以及
// update 只在來源換了才重算 slug(規則改版不會讓既有文章的網址在下次存檔時跑掉)。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock:provider 的 create 會經 getDefaultContentLocale → getSetting
// → secretKeySetAsync,而它 dynamic import loader(真實 loader 在 workers pool 載不起來)。
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

import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const TYPE = "news.post";

const DEF = {
  type: TYPE,
  slugField: "title",
  fields: [
    { key: "title", type: "text" as const },
    { key: "body", type: "text" as const },
    { key: "slug", type: "slug" as const },
  ],
};

async function newProvider(): Promise<CoreContentProvider> {
  const p = new CoreContentProvider(new HookBus());
  await p.ensureType(DEF);
  return p;
}

/** 改版前留下來的列:直接寫表,不經 provider(模擬舊規則存下的 slug)。 */
async function insertLegacy(id: string, slug: string | null, data: Record<string, unknown>) {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES (?, ?, 'en', ?, ?, 'published', ?, 1, 1)",
    )
    .bind(id, TYPE, id, slug, JSON.stringify(data))
    .run();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM content_revisions;");
  invalidateSettingsCache();
});

describe("CoreContentProvider — 中文 slug", () => {
  it("中文標題 → 可讀 slug;同標題依序得到 -2、-3;getBySlug 查得到", async () => {
    const p = await newProvider();
    const a = await p.create(TYPE, { title: "春季新品 2026!" });
    const b = await p.create(TYPE, { title: "春季新品 2026!" });
    const c = await p.create(TYPE, { title: "春季新品 2026!" });
    expect([a.slug, b.slug, c.slug]).toEqual([
      "春季新品-2026",
      "春季新品-2026-2",
      "春季新品-2026-3",
    ]);
    expect((await p.getBySlug(TYPE, "春季新品-2026-2"))?.id).toBe(b.id);
  });

  it("手打的 slug 走同一套正規化;正規化後是空的 → 沒有 slug(不退回標題,沿用既有契約)", async () => {
    const p = await newProvider();
    const typed = await p.create(TYPE, {
      title: "Anything",
      slug: "  營業時間 異動！",
    });
    expect(typed.slug).toBe("營業時間-異動");
    const emptied = await p.create(TYPE, { title: "營業時間異動", slug: "🎉" });
    expect(emptied.slug).toBeNull();
  });

  it("只改內文 → slug 不動,即使原本佔著 base 的那篇已刪除", async () => {
    const p = await newProvider();
    const first = await p.create(TYPE, { title: "營業時間異動" });
    const second = await p.create(TYPE, { title: "營業時間異動" });
    expect(second.slug).toBe("營業時間異動-2");
    await p.delete(TYPE, first.id);
    const updated = await p.update(TYPE, second.id, { body: "改了內文" });
    expect(updated.slug).toBe("營業時間異動-2");
  });

  it("改了標題 → slug 跟著重算", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "春季新品" });
    const renamed = await p.update(TYPE, entry.id, { title: "夏季新品" });
    expect(renamed.slug).toBe("夏季新品");
  });

  it("舊規則留下的空 slug:下次存檔補上可讀的 slug", async () => {
    await insertLegacy("legacy-null", null, { title: "春季新品" });
    const p = await newProvider();
    const updated = await p.update(TYPE, "legacy-null", { body: "x" });
    expect(updated.slug).toBe("春季新品");
  });

  it("舊規則留下的 slug(`2026 春季新品` → `2026`):標題沒改就不動,外部連結不失效", async () => {
    await insertLegacy("legacy-ascii", "2026", { title: "2026 春季新品" });
    const p = await newProvider();
    const updated = await p.update(TYPE, "legacy-ascii", { body: "x" });
    expect(updated.slug).toBe("2026");
  });
});
