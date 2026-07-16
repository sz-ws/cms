import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// D1 FTS5 admin full-text search 的 binding-backed 整合測試(miniflare D1)。
// 同既有測試:mock @/lib/cf 讓 getDB/db() 直接打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);語意與真實一致。
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

import {
  extractSearchText,
  buildMatchQuery,
  indexContentEntry,
  removeContentIndex,
  reindexAll,
  searchContent,
} from "../src/lib/search";
import { GET } from "../src/app/api/search/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

// 真實 migration SQL 的鏡像(migrations/0005 + contents 表最小欄位)。
beforeAll(async () => {
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  // GET /api/search 的 hitRateLimit 沿用 login_attempts 計數表。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
  // route 以 listDeclarativeTypes()(type-directory)補 editHref/typeLabel ——
  // 空表即可(查無 type → editHref null,結果仍回傳)。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM contents;");
  authState.user = EDITOR;
});

// 直接把一筆內容寫進 contents 表(繞過 provider,模擬既有資料)。
async function insertContent(
  id: string,
  type: string,
  status: "draft" | "published",
  data: Record<string, unknown>,
  updatedAt = Date.now(),
): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
    )
    .bind(id, type, status, JSON.stringify(data), updatedAt, updatedAt)
    .run();
}

function ftsCount(): Promise<{ n: number } | null> {
  return d1()
    .prepare("SELECT count(*) AS n FROM content_fts")
    .first<{ n: number }>();
}

function searchReq(q: string, limit?: number): Request {
  const u = new URL(`${ORIGIN}/api/search`);
  u.searchParams.set("q", q);
  if (limit !== undefined) u.searchParams.set("limit", String(limit));
  return new Request(u.toString(), { method: "GET" });
}

// ---- 文字抽取(TS layer)----

describe("extractSearchText", () => {
  it("derives a title-ish field and concatenates string-bearing fields", () => {
    const { title, body } = extractSearchText({
      title: "Hello World",
      category: "news",
      count: 42,
      published: true,
    });
    expect(title).toBe("Hello World");
    expect(body).toContain("Hello World");
    expect(body).toContain("news");
    // 非文字欄位不入 body。
    expect(body).not.toContain("42");
    expect(body).not.toContain("true");
  });

  it("strips HTML tags from string values", () => {
    const { body } = extractSearchText({
      title: "Post",
      lead: "<p>Some <strong>bold</strong> copy</p>",
    });
    expect(body).toContain("Some");
    expect(body).toContain("bold");
    expect(body).toContain("copy");
    expect(body).not.toContain("<");
    expect(body).not.toContain("strong");
  });

  it("extracts plain text from a Tiptap richtext doc (no structural type names)", () => {
    const { body } = extractSearchText({
      title: "Doc",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Alpha bravo charlie" }],
          },
        ],
      },
    });
    expect(body).toContain("Alpha bravo charlie");
    // 結構型別名(doc/paragraph)不得洩漏進 body。
    expect(body).not.toContain("paragraph");
  });

  it("walks nested structural fields (group / repeater / blocks)", () => {
    const { body } = extractSearchText({
      title: "Structured",
      meta: { subtitle: "nested subtitle" }, // group
      rows: [{ label: "row-one" }, { label: "row-two" }], // repeater
      sections: [{ block: "hero", heading: "hero heading" }], // blocks
    });
    expect(body).toContain("nested subtitle");
    expect(body).toContain("row-one");
    expect(body).toContain("row-two");
    expect(body).toContain("hero heading");
    // block discriminator 名稱不入 body。
    expect(body).not.toContain("hero heading hero");
  });

  it("ignores media keys", () => {
    const { body } = extractSearchText({
      title: "Gallery",
      cover: "core/2026/07/abc123XYZ.jpg", // media key shape
    });
    expect(body).toContain("Gallery");
    expect(body).not.toContain("abc123XYZ");
  });
});

// ---- MATCH 淨化 ----

describe("buildMatchQuery", () => {
  it("quotes each term and prefix-matches the last", () => {
    expect(buildMatchQuery("foo bar")).toBe('"foo" "bar"*');
  });

  it("neutralises FTS5 operators without throwing", () => {
    for (const q of ['foo"bar', "foo -bar", "foo*", "(foo OR bar)", "a AND b"]) {
      const m = buildMatchQuery(q);
      // 任一形式都不得為 undefined(要嘛 null 要嘛安全字串)。
      expect(m === null || typeof m === "string").toBe(true);
    }
    // 內含雙引號 → "" 跳脫。
    expect(buildMatchQuery('foo"bar')).toBe('"foo""bar"*');
  });

  it("returns null for punctuation-only input", () => {
    expect(buildMatchQuery("- * ( )")).toBeNull();
    expect(buildMatchQuery("   ")).toBeNull();
  });
});

// ---- indexing on create/update/delete(直接呼叫 exported index 函式)----

describe("index functions", () => {
  it("indexContentEntry inserts a searchable row; re-index replaces it", async () => {
    await insertContent("c1", "blog.post", "published", { title: "First Title" });
    await indexContentEntry("c1", "blog.post", { title: "First Title" });
    let hits = await searchContent("First", 10);
    expect(hits.map((h) => h.id)).toContain("c1");

    // 覆寫 data → re-index:舊詞不再命中,新詞命中。
    await d1()
      .prepare("UPDATE contents SET data = ? WHERE id = ?")
      .bind(JSON.stringify({ title: "Second Heading" }), "c1")
      .run();
    await indexContentEntry("c1", "blog.post", { title: "Second Heading" });

    expect((await searchContent("First", 10)).length).toBe(0);
    hits = await searchContent("Second", 10);
    expect(hits.map((h) => h.id)).toContain("c1");
    // 單一 content_id 不留重複行。
    const c = await ftsCount();
    expect(c?.n).toBe(1);
  });

  it("removeContentIndex drops the row", async () => {
    // 另留一筆已索引內容,確保 content_fts 不會被清空 —— 否則搜尋會觸發惰性
    // backfill(見 reindexAll 測試)。真實 delete 路徑亦是「先刪 contents 列、
    // 再 unindex」,故此處一併移除 contents 列以貼近真實。
    await insertContent("keep", "blog.post", "published", { title: "Keeper" });
    await indexContentEntry("keep", "blog.post", { title: "Keeper" });
    await insertContent("c2", "blog.post", "published", { title: "Removable" });
    await indexContentEntry("c2", "blog.post", { title: "Removable" });
    expect((await searchContent("Removable", 10)).length).toBe(1);

    await d1().prepare("DELETE FROM contents WHERE id = ?").bind("c2").run();
    await removeContentIndex("c2");
    expect((await searchContent("Removable", 10)).length).toBe(0);
    // 其他內容不受影響。
    expect((await searchContent("Keeper", 10)).map((h) => h.id)).toContain(
      "keep",
    );
  });
});

// ---- 搜尋:排序、snippet、HTML 剝除、狀態 ----

describe("searchContent", () => {
  it("returns ranked matches with snippet, status and updatedAt", async () => {
    await insertContent(
      "p1",
      "blog.post",
      "published",
      {
        title: "Coffee brewing guide",
        body: "<p>All about coffee and espresso techniques.</p>",
      },
      1000,
    );
    await insertContent(
      "p2",
      "blog.post",
      "draft",
      { title: "Tea steeping", body: "Green tea and coffee comparison." },
      2000,
    );
    await indexContentEntry("p1", "blog.post", {
      title: "Coffee brewing guide",
      body: "<p>All about coffee and espresso techniques.</p>",
    });
    await indexContentEntry("p2", "blog.post", {
      title: "Tea steeping",
      body: "Green tea and coffee comparison.",
    });

    const hits = await searchContent("coffee", 10);
    expect(hits.length).toBe(2);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");

    const p1 = hits.find((h) => h.id === "p1");
    expect(p1?.status).toBe("published");
    expect(p1?.updatedAt).toBe(1000);
    expect(p1?.typeKey).toBe("blog.post");
    expect(typeof p1?.snippet).toBe("string");
    expect(p1?.snippet.length).toBeGreaterThan(0);
    // snippet 來自剝除 HTML 後的 body,不含標籤。
    expect(p1?.snippet).not.toContain("<p>");

    // draft 也可被 admin 搜尋命中。
    const p2 = hits.find((h) => h.id === "p2");
    expect(p2?.status).toBe("draft");
  });

  it("clamps limit to ≤ 50 and honours a small limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertContent(`m${i}`, "blog.post", "published", {
        title: `match ${i}`,
      });
      await indexContentEntry(`m${i}`, "blog.post", { title: `match ${i}` });
    }
    const two = await searchContent("match", 2);
    expect(two.length).toBe(2);
    // 超過上限:被夾到 50(此處資料僅 5 筆,回全部,不報錯)。
    const big = await searchContent("match", 9999);
    expect(big.length).toBe(5);
  });

  it("empty / too-short query returns empty results", async () => {
    await insertContent("s1", "blog.post", "published", { title: "Something" });
    await indexContentEntry("s1", "blog.post", { title: "Something" });
    expect(await searchContent("", 10)).toEqual([]);
    expect(await searchContent("a", 10)).toEqual([]); // < MIN_QUERY_LENGTH
    expect(await searchContent("   ", 10)).toEqual([]);
  });

  it("does not throw on operator-laden queries", async () => {
    await insertContent("o1", "blog.post", "published", { title: "Widgets" });
    await indexContentEntry("o1", "blog.post", { title: "Widgets" });
    for (const q of ['wid"get', "widget*", "-widget", "(widget)", "a OR b"]) {
      await expect(searchContent(q, 10)).resolves.toBeInstanceOf(Array);
    }
  });
});

// ---- reindexAll backfill ----

describe("reindexAll", () => {
  it("wipes and rebuilds content_fts from contents", async () => {
    await insertContent("r1", "blog.post", "published", { title: "Rebuildable one" });
    await insertContent("r2", "blog.post", "draft", { title: "Rebuildable two" });
    // 尚未索引:content_fts 為空。
    expect((await ftsCount())?.n).toBe(0);

    const n = await reindexAll();
    expect(n).toBe(2);
    expect((await ftsCount())?.n).toBe(2);

    const hits = await searchContent("Rebuildable", 10);
    expect(hits.map((h) => h.id).sort()).toEqual(["r1", "r2"]);
  });

  it("lazy backfill runs on first search when fts is empty but contents is not", async () => {
    await insertContent("b1", "blog.post", "published", { title: "Lazyfill target" });
    expect((await ftsCount())?.n).toBe(0);
    // 沒有任何 index 呼叫,直接搜尋 → 觸發惰性 backfill。
    const hits = await searchContent("Lazyfill", 10);
    expect(hits.map((h) => h.id)).toContain("b1");
    expect((await ftsCount())?.n).toBe(1);
  });
});

// ---- API route ----

describe("GET /api/search", () => {
  it("401 when unauthenticated", async () => {
    authState.user = null;
    const res = await GET(searchReq("coffee"));
    expect(res.status).toBe(401);
  });

  it("200 with results for an authenticated editor (not admin-only)", async () => {
    await insertContent("a1", "blog.post", "published", { title: "Apisearch hit" });
    await indexContentEntry("a1", "blog.post", { title: "Apisearch hit" });
    const res = await GET(searchReq("Apisearch"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ id: string }> };
    expect(body.results.map((r) => r.id)).toContain("a1");
  });

  it("200 empty results for a too-short query", async () => {
    const res = await GET(searchReq("a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});
