import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";

// resolveDashboardCards 的 binding-backed 整合測試(miniflare D1)。db() 走
// @opennextjs/cloudflare 的 getCloudflareContext(pool-workers 內不可用),所以 mock
// @/lib/cf 讓 getDB 直接回傳 cloudflare:test 的 env.DB(同 declarative-migrate.test.ts)。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { resolveDashboardCards } from "../src/ext/dx/dashboard-cards";
import type { Extension } from "../src/ext/types";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const postType: DeclarativeContentType = {
  name: "post",
  label: "Posts",
  slugField: "title", // pickTitleField → title 欄位
  fields: [{ key: "title", type: "text" }],
};
const noteType: DeclarativeContentType = {
  name: "note",
  label: "Notes",
  fields: [{ key: "body", type: "text" }],
};

function makeExt(cards: Extension["dashboardCards"]): Extension {
  return {
    id: "blog",
    name: "Blog",
    version: "1.0.0",
    coreApi: "^1.6.0",
    contentTypes: [postType, noteType],
    dashboardCards: cards,
  };
}

async function insert(row: {
  id: string;
  type: string;
  status: "draft" | "published";
  data: Record<string, unknown>;
  updatedAt: number;
}): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.id,
      row.type,
      null,
      row.status,
      JSON.stringify(row.data),
      row.updatedAt,
      row.updatedAt,
    )
    .run();
}

beforeAll(async () => {
  // 與 src/lib/schema.ts contents 同形(migrations/0001 內的定義)。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT DEFAULT 'draft' NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  // blog.post: 2 published + 2 draft(其中 p4 無 title,測 id 退回);blog.note: 1 published。
  await insert({ id: "p1", type: "blog.post", status: "published", data: { title: "First post" }, updatedAt: 1000 });
  await insert({ id: "p2", type: "blog.post", status: "published", data: { title: "Second post" }, updatedAt: 2000 });
  await insert({ id: "p3", type: "blog.post", status: "draft", data: { title: "Draft post" }, updatedAt: 3000 });
  await insert({ id: "p4", type: "blog.post", status: "draft", data: {}, updatedAt: 4000 });
  await insert({ id: "n1", type: "blog.note", status: "published", data: { body: "hello" }, updatedAt: 1500 });
});

describe("resolveDashboardCards — stat", () => {
  it("counts all entries of the content type (no status filter)", async () => {
    const cards = await resolveDashboardCards([
      makeExt([{ kind: "stat", contentType: "post", title: "All posts" }]),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      extId: "blog",
      extName: "Blog",
      kind: "stat",
      title: "All posts",
      contentType: "blog.post",
      adminHref: "/admin/ext/blog",
      count: 4,
    });
  });

  it("counts only the declared status when status is set", async () => {
    const cards = await resolveDashboardCards([
      makeExt([{ kind: "stat", contentType: "post", status: "published" }]),
    ]);
    expect(cards[0].count).toBe(2);
    // title falls back to the content type label when omitted.
    expect(cards[0].title).toBe("Posts");
  });
});

describe("resolveDashboardCards — recent", () => {
  it("returns the newest entries by updatedAt desc, honouring limit", async () => {
    const cards = await resolveDashboardCards([
      makeExt([{ kind: "recent", contentType: "post", limit: 3 }]),
    ]);
    const entries = cards[0].entries ?? [];
    expect(entries.map((e) => e.id)).toEqual(["p4", "p3", "p2"]);
  });

  it("extracts the display title (slugField/text) and falls back to id", async () => {
    const cards = await resolveDashboardCards([
      makeExt([{ kind: "recent", contentType: "post", limit: 3 }]),
    ]);
    const entries = cards[0].entries ?? [];
    expect(entries[0]).toMatchObject({
      id: "p4",
      title: "p4", // no title in data → falls back to the entry id
      status: "draft",
      editHref: "/admin/ext/blog/edit?id=p4",
    });
    expect(entries[1].title).toBe("Draft post");
  });

  it("defaults to 5 rows when limit is omitted", async () => {
    const cards = await resolveDashboardCards([
      makeExt([{ kind: "recent", contentType: "post" }]),
    ]);
    // Only 4 blog.post rows exist, all returned (< default 5).
    expect(cards[0].entries).toHaveLength(4);
  });
});

describe("resolveDashboardCards — resilience", () => {
  it("skips a card whose content type is not declared (no throw)", async () => {
    const cards = await resolveDashboardCards([
      makeExt([
        { kind: "stat", contentType: "ghost" },
        { kind: "stat", contentType: "post" },
      ]),
    ]);
    // ghost is skipped; the valid post card still resolves.
    expect(cards).toHaveLength(1);
    expect(cards[0].contentType).toBe("blog.post");
  });

  it("returns an empty list when no extension declares cards", async () => {
    const cards = await resolveDashboardCards([makeExt(undefined)]);
    expect(cards).toEqual([]);
  });
});
