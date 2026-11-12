import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.0 頁面快取:宣告式內容(CoreContentProvider)的寫入改變訪客看得到的東西時,通知
// publicContentChanged("content:<type>"),存起來的公開頁才會在下一次造訪時重算。
// 訪客看得到 = status 是 published(公開 API、list/detail view 都只讀 published)。
// 所以寫入前或寫入後是 published 才通知;草稿的新增、修改、刪除不通知 —— 匿名表單
// 送出(一律存成草稿)也因此不會讓整站的頁面失效。寫入失敗(驗證不過)時不通知。

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
import { sanitizePublicCreateBody } from "../src/ext/dx/public-create";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
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
  const N = `content:${TYPE}`;

  it("草稿的新增、修改、刪除都不通知(訪客看不到)", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "草稿" });
    await p.update(TYPE, entry.id, { title: "草稿(改)" });
    await p.update(TYPE, entry.id, { publishAt: Date.now() + 60_000 });
    await p.delete(TYPE, entry.id);
    expect(changed.reasons).toEqual([]);
  });

  it("直接發佈的新增通知一次,reason 帶內容型別", async () => {
    const p = await newProvider();
    await p.create(TYPE, { title: "上線", status: "published" });
    expect(changed.reasons).toEqual([N]);
  });

  it("發佈、修改已發佈、下架、刪除已發佈各通知一次", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "第一篇" });
    expect(changed.reasons).toEqual([]);

    await p.update(TYPE, entry.id, { status: "published" }); // 發佈
    expect(changed.reasons).toEqual([N]);

    await p.update(TYPE, entry.id, { title: "第一篇(改)" }); // 已發佈的修改
    expect(changed.reasons).toEqual([N, N]);

    await p.update(TYPE, entry.id, { status: "draft" }); // 下架
    expect(changed.reasons).toEqual([N, N, N]);

    await p.update(TYPE, entry.id, { title: "下架後再改" }); // 又是草稿
    expect(changed.reasons).toEqual([N, N, N]);

    await p.update(TYPE, entry.id, { status: "published" });
    await p.delete(TYPE, entry.id); // 刪除已發佈
    expect(changed.reasons).toEqual([N, N, N, N, N]);
  });

  it("匿名表單送出(帶 status: published 也一樣)存成草稿,不通知", async () => {
    const p = await newProvider();
    const ct = {
      name: "post",
      public: true,
      fields: DEF.fields,
    } as unknown as DeclarativeContentType;
    const body = sanitizePublicCreateBody({ title: "spam", status: "published" }, ct);
    const entry = await p.create(TYPE, body);
    expect(entry.status).toBe("draft");
    expect(changed.reasons).toEqual([]);
  });

  it("驗證不過、沒有寫入 → 不通知", async () => {
    const p = await newProvider();
    await expect(p.create(TYPE, { status: "published" })).rejects.toThrow();
    expect(changed.reasons).toEqual([]);
  });
});
