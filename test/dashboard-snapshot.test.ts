import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

const queryMetrics = vi.hoisted(() => ({
  batchCalls: 0,
  statementCounts: [] as number[],
  cacheKeys: [] as string[][],
}));

// 不做真的快取(每次都打 D1),但把 cache key 記下來 —— 標題欄位換掉時 key 必須跟著
// 變,否則會拿到「照舊 key 裁過的 data」。
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, key: string[]) => {
    queryMetrics.cacheKeys.push(key);
    return fn;
  },
}));

vi.mock("@/lib/cf", () => ({
  getDB: () => {
    const binding = (env as { DB: D1Database }).DB;
    return {
      prepare: binding.prepare.bind(binding),
      batch: async (statements: D1PreparedStatement[]) => {
        queryMetrics.batchCalls++;
        queryMetrics.statementCounts.push(statements.length);
        return binding.batch(statements);
      },
    } as D1Database;
  },
}));

import {
  getDashboardContentSnapshot,
  queryDashboardContentSnapshot,
} from "../src/components/admin/dashboard/snapshot";

const d1 = () => (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  queryMetrics.batchCalls = 0;
  queryMetrics.statementCounts = [];
  queryMetrics.cacheKeys = [];
});

async function insert(
  id: string,
  type: string,
  status: "draft" | "published",
  updatedAt: number,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES (?, ?, 'en', ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      type,
      id,
      id,
      status,
      JSON.stringify({ title, ...extra }),
      updatedAt,
      updatedAt,
    )
    .run();
}

/** 呼叫端(aggregate.ts)現在連標題欄位 key 一起傳;測試沿用預設的 `title`。 */
const withTitleKey = (
  ...typeKeys: string[]
): { typeKey: string; titleKey: string }[] =>
  typeKeys.map((typeKey) => ({ typeKey, titleKey: "title" }));

describe("dashboard content snapshot", () => {
  it("gets all type counts and recent rows in one two-statement D1 batch", async () => {
    await insert("a1", "blog.post", "published", 100, "Old post");
    await insert("a2", "blog.post", "draft", 300, "Draft post");
    await insert("b1", "shop.product", "published", 200, "Product");
    await insert("ignored", "disabled.note", "published", 999, "Ignore me");

    const snapshot = await queryDashboardContentSnapshot(
      withTitleKey("shop.product", "blog.post", "blog.post"),
    );

    expect(queryMetrics.batchCalls).toBe(1);
    expect(queryMetrics.statementCounts).toEqual([2]);
    expect(snapshot.counts).toEqual([
      { type: "blog.post", total: 2, published: 1 },
      { type: "shop.product", total: 1, published: 1 },
    ]);
    expect(snapshot.recent.map((entry) => entry.id)).toEqual(["a2", "b1", "a1"]);
    expect(snapshot.recent[0].data).toEqual({ title: "Draft post" });
  });

  it("does not contact D1 when no declarative types are enabled", async () => {
    await expect(queryDashboardContentSnapshot([])).resolves.toEqual({
      counts: [],
      recent: [],
    });
    expect(queryMetrics.batchCalls).toBe(0);
  });

  it("keeps only the title field in recent rows so bodies never reach the cache", async () => {
    await insert("a1", "blog.post", "draft", 100, "Draft post", {
      body: "unpublished body that must not be cached",
      secretNote: "internal",
    });

    const snapshot = await queryDashboardContentSnapshot(
      withTitleKey("blog.post"),
    );

    expect(snapshot.recent[0].data).toEqual({ title: "Draft post" });
    expect(snapshot.recent[0].data).not.toHaveProperty("body");
    expect(snapshot.recent[0].data).not.toHaveProperty("secretNote");
  });

  it("reduces each row against its own type's title key", async () => {
    await insert("a1", "blog.post", "published", 200, "Post title", {
      name: "not the blog title field",
    });
    await insert("b1", "shop.product", "published", 100, "ignored", {
      name: "Product name",
    });

    const snapshot = await queryDashboardContentSnapshot([
      { typeKey: "blog.post", titleKey: "title" },
      { typeKey: "shop.product", titleKey: "name" },
    ]);

    expect(snapshot.recent.map((entry) => entry.data)).toEqual([
      { title: "Post title" },
      { name: "Product name" },
    ]);
  });

  it("varies the cache key when a type's title field changes", async () => {
    await insert("a1", "blog.post", "published", 100, "Post title", {
      headline: "Headline",
    });

    const byTitle = await getDashboardContentSnapshot([
      { typeKey: "blog.post", titleKey: "title" },
    ]);
    const byHeadline = await getDashboardContentSnapshot([
      { typeKey: "blog.post", titleKey: "headline" },
    ]);

    expect(byTitle.recent[0].data).toEqual({ title: "Post title" });
    expect(byHeadline.recent[0].data).toEqual({ headline: "Headline" });
    expect(queryMetrics.cacheKeys).toHaveLength(2);
    expect(queryMetrics.cacheKeys[0]).not.toEqual(queryMetrics.cacheKeys[1]);
    expect(queryMetrics.cacheKeys[0][1]).toBe(
      JSON.stringify([["blog.post", "title"]]),
    );
  });
});
