import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.0 頁面快取:宣告式內容的新增、修改、刪除(CoreContentProvider)寫完之後都要通知
// publicContentChanged("content:<type>"),存起來的公開頁才會在下一次造訪時重算。
// 寫入失敗(驗證不過)時不通知 —— 沒有東西變。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// 同 content-slug.test.ts:真實 loader 在 workers pool 載不起來。
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

const changed = vi.hoisted(() => ({ reasons: [] as string[] }));
vi.mock("@/lib/public-cache", () => ({
  publicContentChanged: (reason: string) => {
    changed.reasons.push(reason);
  },
}));

import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const TYPE = "pcache.post";

const DEF = {
  type: TYPE,
  slugField: "title",
  fields: [
    { key: "title", type: "text" as const, required: true },
    { key: "slug", type: "slug" as const },
  ],
};

async function newProvider(): Promise<CoreContentProvider> {
  const p = new CoreContentProvider(new HookBus());
  await p.ensureType(DEF);
  return p;
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
  changed.reasons = [];
});

describe("CoreContentProvider → publicContentChanged", () => {
  it("新增、修改、刪除各通知一次,reason 帶內容型別", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "第一篇" });
    expect(changed.reasons).toEqual([`content:${TYPE}`]);

    await p.update(TYPE, entry.id, { title: "第一篇(改)" });
    expect(changed.reasons).toEqual([`content:${TYPE}`, `content:${TYPE}`]);

    await p.delete(TYPE, entry.id);
    expect(changed.reasons).toEqual([`content:${TYPE}`, `content:${TYPE}`, `content:${TYPE}`]);
  });

  it("驗證不過、沒有寫入 → 不通知", async () => {
    const p = await newProvider();
    await expect(p.create(TYPE, {})).rejects.toThrow();
    expect(changed.reasons).toEqual([]);
  });
});
