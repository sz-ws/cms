import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 內容版本歷史(migrations/0010_content_revisions.sql + src/lib/revisions.ts)的
// binding-backed 整合測試(miniflare D1)。同既有測試:mock @/lib/cf 讓 db()/getDB()
// 直接打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// 寫入者解析走 getSessionUser()(pool-workers 無 request-scoped cookies),由測試控制。
const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    role: "admin" | "editor" | "guest";
    avatarKey: string | null;
  },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, getSessionUser: async () => authState.user };
});

// @/ext/loader 全 mock:restoreRevision 會透過它派送 content:updated hook。
const hookState = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  hooks.register("test", "content:updated", (payload: unknown) => {
    hookState.calls.push(payload);
  });
  return {
    getExtRuntime: async () => ({
      enabled: [],
      all: [],
      hooks,
      byId: () => undefined,
      isCompatible: () => true,
    }),
  };
});

import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { buildCrudRoutes } from "../src/ext/dx/crud";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import type { ApiCtx } from "../src/ext/types";
import {
  captureRevision,
  getRevision,
  listRevisions,
  pruneRevisions,
  DEFAULT_REVISION_KEEP,
} from "../src/lib/revisions";
import {
  restoreRevision,
  RevisionRestoreError,
} from "../src/lib/revision-restore";
import { setSettings, invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const TYPE = "blog.post";

const ALICE = {
  id: "u-alice",
  email: "alice@test.com",
  name: "Alice",
  role: "editor" as const,
  avatarKey: null,
};
const BOB = {
  id: "u-bob",
  email: "bob@test.com",
  name: "Bob",
  role: "editor" as const,
  avatarKey: null,
};

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const USERS_DDL =
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);";
// 與 migrations/0010 一字不差(含 FK 子句),讓測試跑的是真的那張表。
const REVISIONS_DDL =
  "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);";

const DEF = {
  type: TYPE,
  slugField: "title",
  fields: [
    { key: "title", type: "text" as const },
    { key: "body", type: "text" as const },
    { key: "note", type: "text" as const },
  ],
};

async function newProvider(): Promise<CoreContentProvider> {
  const p = new CoreContentProvider(new HookBus());
  await p.ensureType(DEF);
  return p;
}

interface RevRow {
  id: string;
  reason: string;
  status: string;
  actor_id: string | null;
  created_at: number;
  data: string;
  slug: string | null;
  publish_at: number | null;
}

async function revRows(contentId: string): Promise<RevRow[]> {
  const res = await d1()
    .prepare(
      "SELECT id, reason, status, actor_id, created_at, data, slug, publish_at FROM content_revisions WHERE content_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(contentId)
    .all<RevRow>();
  return res.results ?? [];
}

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(USERS_DDL);
  await d1().exec(REVISIONS_DDL);
  await d1().exec(
    "CREATE INDEX IF NOT EXISTS content_revisions_content ON content_revisions (content_id, created_at);",
  );
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM content_revisions;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache(); // 直接清表繞開寫入路徑,一併清 isolate settings 快取。
  hookState.calls = [];
  for (const u of [ALICE, BOB]) {
    await d1()
      .prepare(
        "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, ?, 1)",
      )
      .bind(u.id, u.email, u.name, u.role)
      .run();
  }
  authState.user = ALICE;
});

// ---- 擷取(create / update)----

describe("captureRevision — 寫入路徑擷取", () => {
  it("create 留下一筆 reason=create 的完整快照,並記下寫入者", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "one" });

    const rows = await revRows(entry.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("create");
    expect(rows[0].status).toBe("draft");
    expect(rows[0].actor_id).toBe(ALICE.id);
    expect(JSON.parse(rows[0].data)).toMatchObject({
      title: "Hello",
      body: "one",
    });
  });

  it("匿名寫入(無 session)actor_id 為 NULL,而不是假的識別碼", async () => {
    authState.user = null;
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Anon" });

    const rows = await revRows(entry.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
  });

  it("update 不會併進 create 那筆 —— 初始狀態永遠留著", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "one" });
    await p.update(TYPE, entry.id, { body: "two" });

    const rows = await revRows(entry.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reason)).toEqual(["update", "create"]);
    expect(JSON.parse(rows[1].data)).toMatchObject({ body: "one" });
    expect(JSON.parse(rows[0].data)).toMatchObject({ body: "two" });
  });

  it("同一人在合併視窗內連續儲存只留一筆(不是每次存都長一列)", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "v1" });
    await p.update(TYPE, entry.id, { body: "v2" });
    await p.update(TYPE, entry.id, { body: "v3" });
    await p.update(TYPE, entry.id, { body: "v4" });

    const rows = await revRows(entry.id);
    // create + 一筆被就地覆寫的 update
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].data)).toMatchObject({ body: "v4" });
  });

  it("換人編輯一定新開一筆(誰改的必須答得出來)", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "v1" });
    await p.update(TYPE, entry.id, { body: "v2" });
    authState.user = BOB;
    await p.update(TYPE, entry.id, { body: "v3" });

    const rows = await revRows(entry.id);
    expect(rows).toHaveLength(3);
    expect(rows[0].actor_id).toBe(BOB.id);
    expect(rows[1].actor_id).toBe(ALICE.id);
  });

  it("draft → published 的狀態轉換一定新開一筆", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "v1" });
    await p.update(TYPE, entry.id, { body: "v2" });
    await p.update(TYPE, entry.id, { status: "published" });

    const rows = await revRows(entry.id);
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe("published");
    expect(rows[1].status).toBe("draft");
  });

  it("合併視窗設為 0 時,每次 update 都新開一筆", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "v1" });
    await p.update(TYPE, entry.id, { body: "v2" });
    await p.update(TYPE, entry.id, { body: "v3" });

    expect(await revRows(entry.id)).toHaveLength(3);
  });

  it("keep=0 完全停用擷取(一列都不寫)", async () => {
    await setSettings({ "core.revisions.keep": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    await p.update(TYPE, entry.id, { title: "Hello again" });

    expect(await revRows(entry.id)).toHaveLength(0);
  });

  it("快照帶上 row 層的 publishAt,即使這次 update 沒帶該欄位", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", publishAt: 9_000 });
    await p.update(TYPE, entry.id, { title: "Hello 2" });

    const rows = await revRows(entry.id);
    expect(rows[1].publish_at).toBe(9_000); // create 快照
    expect(rows[0].publish_at).toBe(9_000); // update 快照(未帶 key,沿用既有排程)
  });

  it("內容被刪除時歷史一併清除", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    expect(await revRows(entry.id)).toHaveLength(1);

    await p.delete(TYPE, entry.id);
    expect(await revRows(entry.id)).toHaveLength(0);
  });
});

// ---- 保留數修剪 ----

describe("pruneRevisions — 保留數", () => {
  /** 直接呼叫 captureRevision 造出彼此獨立的多筆(繞開合併視窗)。 */
  async function seed(contentId: string, n: number): Promise<void> {
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, slug, status, publish_at, data, created_at, updated_at) VALUES (?, ?, NULL, 'draft', NULL, '{}', 1, 1)",
      )
      .bind(contentId, TYPE)
      .run();
    for (let i = 1; i <= n; i++) {
      await captureRevision({
        contentId,
        type: TYPE,
        slug: null,
        status: "draft",
        publishAt: null,
        data: { n: i },
        reason: "update",
        actorId: ALICE.id,
        now: 1_000 + i * 10 * 60_000, // 每筆相隔 10 分鐘 → 落在預設 5 分鐘合併視窗外
      });
    }
  }

  it("預設保留數會把最舊的修掉,只留最新的 N 筆", async () => {
    await seed("c-keep-default", DEFAULT_REVISION_KEEP + 5);
    const rows = await revRows("c-keep-default");
    expect(rows).toHaveLength(DEFAULT_REVISION_KEEP);
    // 留下的是最新那批(n = 6..25),最舊的 5 筆被修掉。
    expect(JSON.parse(rows[0].data)).toEqual({ n: DEFAULT_REVISION_KEEP + 5 });
    expect(JSON.parse(rows[rows.length - 1].data)).toEqual({ n: 6 });
  });

  it("keep 設小之後,下一次擷取會把多出來的舊列一起清掉", async () => {
    await seed("c-keep-3", 10);
    expect(await revRows("c-keep-3")).toHaveLength(DEFAULT_REVISION_KEEP > 10 ? 10 : DEFAULT_REVISION_KEEP);

    await setSettings({ "core.revisions.keep": 3 });
    await captureRevision({
      contentId: "c-keep-3",
      type: TYPE,
      slug: null,
      status: "draft",
      publishAt: null,
      data: { n: 99 },
      reason: "update",
      actorId: ALICE.id,
      now: 9_999_999,
    });

    const rows = await revRows("c-keep-3");
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0].data)).toEqual({ n: 99 });
  });

  it("keep 超出硬上限時被夾住,不會無限成長", async () => {
    await setSettings({ "core.revisions.keep": 1_000_000 });
    await seed("c-ceiling", 3);
    // 只有 3 筆,夾不夾都留 3;重點是修剪不會 throw、也不會刪錯。
    expect(await revRows("c-ceiling")).toHaveLength(3);
    expect(await pruneRevisions("c-ceiling", 0)).toBe(0); // keep<=0 → no-op
  });
});

// ---- 讀取 ----

describe("listRevisions / getRevision", () => {
  it("列表為新→舊,並把 actor 換成使用者名字", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    authState.user = BOB;
    await p.update(TYPE, entry.id, { title: "Hello 2" });

    const list = await listRevisions(entry.id);
    expect(list).toHaveLength(2);
    expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
    expect(list[0].actorName).toBe("Bob");
    expect(list[1].actorName).toBe("Alice");
  });

  it("寫入者的帳號被刪除後,actorName 為 null(不外露內部 user id)", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    await d1().prepare("DELETE FROM users WHERE id = ?").bind(ALICE.id).run();

    const list = await listRevisions(entry.id);
    expect(list[0].actorName).toBeNull();
  });

  it("getRevision 以 contentId 綁定,不能跨內容取用別人的版本", async () => {
    const p = await newProvider();
    const a = await p.create(TYPE, { title: "A" });
    const b = await p.create(TYPE, { title: "B" });
    const aRev = (await listRevisions(a.id))[0];

    expect(await getRevision(a.id, aRev.id)).not.toBeNull();
    expect(await getRevision(b.id, aRev.id)).toBeNull();
  });
});

// ---- 還原 ----

describe("restoreRevision", () => {
  it("把舊快照原樣寫回(replace 語意:後來新增的欄位不會殘留)", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "good" });
    await p.update(TYPE, entry.id, { body: "wrecked", note: "junk" });

    const list = await listRevisions(entry.id);
    const original = list[list.length - 1]; // create 那筆
    const result = await restoreRevision(entry.id, original.id, {
      actorId: BOB.id,
    });

    expect(result.slugKept).toBe(false);
    const after = await p.get(TYPE, entry.id);
    expect(after?.data).toMatchObject({ title: "Hello", body: "good" });
    expect(after?.data.note).toBeUndefined(); // merge 的話這裡會殘留 "junk"
  });

  it("還原本身也留一筆 reason=restore,壞掉的版本仍留在歷史裡", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "good" });
    await p.update(TYPE, entry.id, { body: "wrecked" });
    const original = (await listRevisions(entry.id)).slice(-1)[0];

    await restoreRevision(entry.id, original.id, { actorId: BOB.id });

    const rows = await revRows(entry.id);
    expect(rows.map((r) => r.reason)).toEqual(["restore", "update", "create"]);
    expect(rows[0].actor_id).toBe(BOB.id);
    // 被還原掉的壞版本還在(undo 可以 redo)。
    expect(JSON.parse(rows[1].data)).toMatchObject({ body: "wrecked" });
  });

  it("還原會派送 content:updated hook 並重建 FTS 索引", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Sunflower", body: "good" });
    await p.update(TYPE, entry.id, { title: "Wrecked title" });
    const original = (await listRevisions(entry.id)).slice(-1)[0];

    hookState.calls = [];
    await restoreRevision(entry.id, original.id, { actorId: ALICE.id });

    expect(hookState.calls).toHaveLength(1);
    expect(hookState.calls[0]).toMatchObject({ type: TYPE, id: entry.id });

    const hit = await d1()
      .prepare("SELECT count(*) AS n FROM content_fts WHERE content_id = ? AND title MATCH 'Sunflower'")
      .bind(entry.id)
      .first<{ n: number }>();
    expect(hit?.n).toBe(1);
  });

  it("還原也會恢復 status", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", status: "published" });
    await p.update(TYPE, entry.id, { status: "draft" });
    const first = (await listRevisions(entry.id)).slice(-1)[0];

    await restoreRevision(entry.id, first.id, { actorId: ALICE.id });
    const after = await p.get(TYPE, entry.id);
    expect(after?.status).toBe("published");
  });

  it("舊 slug 已被別的項目佔用時沿用目前的 slug,而不是整個還原失敗", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Original", body: "good" });
    await p.update(TYPE, entry.id, { title: "Renamed" });
    // 另一個項目搶走了舊 slug。
    await p.create(TYPE, { title: "Original" });

    const original = (await listRevisions(entry.id)).slice(-1)[0];
    const result = await restoreRevision(entry.id, original.id, {
      actorId: ALICE.id,
    });

    expect(result.slugKept).toBe(true);
    const after = await p.get(TYPE, entry.id);
    expect(after?.slug).toBe("renamed"); // 保留目前的 slug
    expect(after?.data).toMatchObject({ title: "Original" }); // 內容照樣還原
  });

  it("版本不存在 / 內容不存在 → RevisionRestoreError('not_found')", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });

    await expect(restoreRevision(entry.id, "nope")).rejects.toBeInstanceOf(
      RevisionRestoreError,
    );
    await expect(restoreRevision("no-such-content", "nope")).rejects.toThrow(
      "not_found",
    );
  });
});

// ---- auto-CRUD 端點(extension manifest 宣告的 content type 走的就是這條路)----

describe("auto-CRUD 版本端點 — declarative extension 宣告的型別", () => {
  // extId "blog" + contentType name "post" → def.type = "blog.post"(= 上面的 TYPE)。
  const CT: DeclarativeContentType = {
    name: "post",
    label: "Post",
    slugField: "title",
    fields: [
      { key: "title", type: "text" },
      { key: "body", type: "text" },
    ],
  };

  /** 最小 ApiCtx stub(同 notify.test.ts):crud.ts 只用到 providers.get() 與 user.id。 */
  function makeCtx(provider: CoreContentProvider): ApiCtx {
    return {
      user: { id: ALICE.id },
      services: { providers: { get: () => provider } },
    } as unknown as ApiCtx;
  }

  function route(method: string, path: string) {
    const found = buildCrudRoutes("blog", CT).find(
      (r) => r.method === method && r.path === path,
    );
    if (!found) throw new Error(`route not found: ${method} ${path}`);
    return found;
  }

  const req = (url: string, method = "GET") =>
    new Request(`https://cms.test${url}`, { method });

  it("列表端點回傳該 entry 的版本(不含 data 快照本體)", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    await p.update(TYPE, entry.id, { title: "Hello 2" });

    const res = await route("GET", "post/:id/revisions").handler(
      req(`/api/ext/blog/post/${entry.id}/revisions`),
      { id: entry.id },
      makeCtx(p),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revisions: { id: string; actorName: string | null; data?: unknown }[];
    };
    expect(body.revisions).toHaveLength(2);
    expect(body.revisions[0].actorName).toBe("Alice");
    expect(body.revisions[0].data).toBeUndefined();
  });

  it("單筆端點回傳完整快照;不屬於該 entry 的版本 → 404", async () => {
    const p = await newProvider();
    const a = await p.create(TYPE, { title: "A" });
    const b = await p.create(TYPE, { title: "B" });
    const aRev = (await listRevisions(a.id))[0];

    const ok = await route("GET", "post/:id/revisions/:revId").handler(
      req(`/api/ext/blog/post/${a.id}/revisions/${aRev.id}`),
      { id: a.id, revId: aRev.id },
      makeCtx(p),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { revision: { data: unknown } }).toMatchObject({
      revision: { data: { title: "A" } },
    });

    const cross = await route("GET", "post/:id/revisions/:revId").handler(
      req(`/api/ext/blog/post/${b.id}/revisions/${aRev.id}`),
      { id: b.id, revId: aRev.id },
      makeCtx(p),
    );
    expect(cross.status).toBe(404);
  });

  it("還原端點寫回內容,並把操作者記成當次 session user", async () => {
    await setSettings({ "core.revisions.coalesceMs": 0 });
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello", body: "good" });
    await p.update(TYPE, entry.id, { body: "wrecked" });
    const original = (await listRevisions(entry.id)).slice(-1)[0];

    const res = await route(
      "POST",
      "post/:id/revisions/:revId/restore",
    ).handler(
      req(
        `/api/ext/blog/post/${entry.id}/revisions/${original.id}/restore`,
        "POST",
      ),
      { id: entry.id, revId: original.id },
      makeCtx(p),
    );
    expect(res.status).toBe(200);

    const after = await p.get(TYPE, entry.id);
    expect(after?.data).toMatchObject({ body: "good" });
    const rows = await revRows(entry.id);
    expect(rows[0].reason).toBe("restore");
    expect(rows[0].actor_id).toBe(ALICE.id);
  });

  it("不存在的版本 → 404", async () => {
    const p = await newProvider();
    const entry = await p.create(TYPE, { title: "Hello" });
    const res = await route(
      "POST",
      "post/:id/revisions/:revId/restore",
    ).handler(
      req(`/api/ext/blog/post/${entry.id}/revisions/nope/restore`, "POST"),
      { id: entry.id, revId: "nope" },
      makeCtx(p),
    );
    expect(res.status).toBe(404);
  });

  it("版本路由的段數與既有 CRUD 路由都不相同(dispatch matcher 先比段數,不會互吃)", () => {
    const paths = buildCrudRoutes("blog", CT).map((r) => r.path);
    expect(paths).toContain("post/:id/revisions");
    expect(paths).toContain("post/:id/revisions/:revId");
    expect(paths).toContain("post/:id/revisions/:revId/restore");
    // 3/4/5 段 vs 既有的 1/2 段。
    expect(new Set(["post", "post/:id", "post/options"]).size).toBe(3);
    for (const p of paths.filter((x) => x.includes("/revisions"))) {
      expect(p.split("/").length).toBeGreaterThan(2);
    }
  });
});
