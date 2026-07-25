import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 公開表單收件語意(CORE_API 1.22.0)的整合測試。
//
// 本檔最重要的三組斷言,順序即重要性:
//   1. 收件內容**無法**經由公開路由讀到。
//   2. 收件內容**無法**經由公開 Content API 讀到 —— 即使那一列被硬改成 published。
//   3. publish-due(排程發佈)**永遠**不會把收件列翻成 published。
// 前兩者外洩就是隱私事故,不是 bug;第三者是通往前兩者的自動化路徑。
//
// 同既有測試:mock @/lib/cf 讓 db()/getDB() 直接打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// 註:本檔**刻意不** import src/ext/dx/interpret.tsx —— 它經 views 拉進
// next/navigation、next/link、framer-motion,在 workers pool 測試環境載不起來
// (dx/schedule-jobs.ts、dx/dashboard-cards.ts 檔頭記載的同一個地雷)。這正是
// 「公開面會不會生成讀取路由」與「submission 的 CRUD 表面長什麼樣」兩個決策被抽進
// 純模組(dx/submission.ts、dx/crud.ts)的原因:最重要的正確性需求必須是測試能
// 直接斷言的東西。interpret.tsx 對這兩者只是轉呼叫,沒有第二份判斷邏輯。

// Content API 的快取層換成直接查真實 provider(照 content-api.test.ts 的既有做法):
// 路由語意(auth / gating / published-only / submission 擋牆)完全不變。
vi.mock("@/ext/dx/content-cache", async () => {
  const { CoreContentProvider } = await import(
    "../src/ext/dx/content-provider"
  );
  const { HookBus } = await import("../src/ext/hooks");
  const provider = new CoreContentProvider(new HookBus());
  return {
    cachedPublicQuery: (_extId: string, type: string, q: unknown) =>
      provider.query(type, q as never),
    cachedPublicGetBySlug: (_extId: string, type: string, slug: string) =>
      provider.getBySlug(type, slug),
    cachedExtStylesheet: async () => null,
  };
});

// publish-due 會透過 loader 派發 content:updated hook;給一個空 runtime 即可。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  return {
    getExtRuntime: async () => ({
      enabled: [] as unknown[],
      all: [] as unknown[],
      hooks,
      byId: () => undefined,
      isCompatible: () => true,
    }),
  };
});

import { parseManifest } from "../src/ext/dx/manifest";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import { buildCrudRoutes } from "../src/ext/dx/crud";
import {
  allowedPublicRoutes,
  isSubmissionType,
  submissionTypeNames,
  type SubmissionManifestShape,
} from "../src/ext/dx/submission";
import {
  deleteSubmissionRecord,
  listSubmissions,
  setSubmissionReplied,
  setSubmissionState,
  stampNewSubmission,
  submissionCounts,
} from "../src/lib/submissions";
import { createApiToken } from "../src/lib/api-token";
import { GET as contentApiGet } from "../src/app/api/content/[extId]/[type]/[[...rest]]/route";
import { runDueJobs } from "../src/lib/jobs";
import { CORE_API_VERSION } from "../src/ext/version";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const ORIGIN = "https://cms.test";

// ---- fixtures ─────────────────────────────────────────────────────────────

/** registry 的 contact extension 的形狀:public + notifyOnCreate + 只有 view:"form"。 */
const CONTACT_MANIFEST = {
  kind: "declarative",
  id: "contact",
  name: "Contact",
  version: "1.0.0",
  coreApi: "^1.11.0",
  contentTypes: [
    {
      name: "submission",
      label: "Submissions",
      public: true,
      notifyOnCreate: true,
      fields: [
        { key: "name", type: "text", label: "Name", required: true },
        { key: "email", type: "text", label: "Email", required: true },
        { key: "message", type: "text", label: "Message" },
      ],
    },
  ],
  adminPages: [
    { slug: "", title: "Submissions", view: "collection", contentType: "submission" },
  ],
  publicRoutes: [
    { pattern: "/contact", view: "form", contentType: "submission" },
  ],
  schedule: [
    {
      id: "purge",
      every: 1440,
      action: { op: "deleteOlderThan", contentType: "submission", days: 180 },
    },
  ],
} as const;

const CONTACT_TYPE = "contact.submission";

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_submissions (content_id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unread', replied_at INTEGER, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'read', last_used_at INTEGER, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM content_submissions;");
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM api_tokens;");
  await d1().exec("DELETE FROM settings;");
});

async function insertContent(opts: {
  id: string;
  type: string;
  status: "draft" | "published";
  slug?: string | null;
  publishAt?: number | null;
  data?: Record<string, unknown>;
  createdAt?: number;
}): Promise<void> {
  const now = opts.createdAt ?? Date.now();
  await d1()
    .prepare(
      "INSERT INTO contents (id, type, slug, status, publish_at, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      opts.id,
      opts.type,
      opts.slug ?? null,
      opts.status,
      opts.publishAt ?? null,
      JSON.stringify(opts.data ?? {}),
      now,
      now,
    )
    .run();
}

async function insertDx(id: string, manifest: unknown): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, stylesheet, installed_at, updated_at) VALUES (?, ?, '1.0.0', 1, NULL, NULL, ?, ?)",
    )
    .bind(id, JSON.stringify(manifest), now, now)
    .run();
}

function apiParams(extId: string, type: string, rest?: string[]) {
  return { params: Promise.resolve({ extId, type, rest }) };
}

// ---- 1. 分類規則(純函式,無 DB)───────────────────────────────────────────

describe("submission kind resolution", () => {
  it("treats an explicit kind:\"submission\" type as a submission", () => {
    const m: SubmissionManifestShape = {
      contentTypes: [{ name: "msg", kind: "submission" }],
    };
    expect(isSubmissionType(m, m.contentTypes![0])).toBe(true);
  });

  it("lets an author opt out with an explicit kind:\"content\"", () => {
    const m: SubmissionManifestShape = {
      contentTypes: [{ name: "post", kind: "content", public: true }],
      publicRoutes: [],
    };
    expect(isSubmissionType(m, m.contentTypes![0])).toBe(false);
  });

  it("infers a submission for a public type with no public read route (the shipped `contact` shape)", () => {
    // 這是向後相容的核心斷言:registry 既有的 contact manifest 一個字都沒改,
    // 就自動取得收件匣語意。
    expect(submissionTypeNames(CONTACT_MANIFEST)).toEqual(
      new Set(["submission"]),
    );
  });

  it("does NOT infer a submission when the type has a public list route", () => {
    // 公開留言板那種 UGC:匿名可寫、也公開可讀 → 仍是內容,行為與 1.22.0 之前一致。
    const m: SubmissionManifestShape = {
      contentTypes: [{ name: "guestbook", public: true }],
      publicRoutes: [{ pattern: "/wall", view: "list", contentType: "guestbook" }],
    };
    expect(submissionTypeNames(m).size).toBe(0);
  });

  it("does NOT infer a submission when the type has a public detail route", () => {
    const m: SubmissionManifestShape = {
      contentTypes: [{ name: "guestbook", public: true }],
      publicRoutes: [
        { pattern: "/wall/:slug", view: "detail", contentType: "guestbook" },
      ],
    };
    expect(submissionTypeNames(m).size).toBe(0);
  });

  it("does NOT infer a submission for a non-public type", () => {
    const m: SubmissionManifestShape = {
      contentTypes: [{ name: "page" }],
    };
    expect(submissionTypeNames(m).size).toBe(0);
  });
});

// ---- 2. manifest 驗證:宣告 submission 又開公開讀取路由 = install 當下就炸 ────

describe("manifest validation", () => {
  const base = {
    kind: "declarative",
    id: "leaky",
    name: "Leaky",
    version: "1.0.0",
    coreApi: `^${CORE_API_VERSION}`,
    contentTypes: [
      {
        name: "msg",
        kind: "submission",
        public: true,
        fields: [{ key: "body", type: "text", label: "Body" }],
      },
    ],
  };

  it("accepts a submission type that only has a public form route", () => {
    const parsed = parseManifest({
      ...base,
      publicRoutes: [{ pattern: "/contact", view: "form", contentType: "msg" }],
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a public list route on a kind:\"submission\" type", () => {
    const parsed = parseManifest({
      ...base,
      publicRoutes: [{ pattern: "/msgs", view: "list", contentType: "msg" }],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/submission/i);
  });

  it("rejects a public detail route on a kind:\"submission\" type", () => {
    const parsed = parseManifest({
      ...base,
      publicRoutes: [
        { pattern: "/msgs/:slug", view: "detail", contentType: "msg" },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it("keeps accepting the shipped contact manifest unchanged", () => {
    const parsed = parseManifest(CONTACT_MANIFEST);
    expect(parsed.ok).toBe(true);
  });
});

// ---- 3. 公開路由:收件內容不可觸及 ────────────────────────────────────────

describe("submissions are not reachable through the public route", () => {
  it("keeps only the form route for the shipped contact manifest", () => {
    const kept = allowedPublicRoutes(
      CONTACT_MANIFEST,
      CONTACT_MANIFEST.publicRoutes,
    );
    expect(kept.map((r) => r.view)).toEqual(["form"]);
  });

  it("strips list and detail routes that point at a submission type", () => {
    // 手改 DB 繞過 manifest 驗證的情境:interpret 仍然一條讀取路由都不會生成,
    // 所以 (public)/[...slug] 的 dispatch 迴圈永遠找不到能匹配收件內容的路由。
    const manifest = {
      contentTypes: [{ name: "msg", kind: "submission", public: true }],
      publicRoutes: [
        { pattern: "/msgs", view: "list", contentType: "msg" },
        { pattern: "/msgs/:slug", view: "detail", contentType: "msg" },
        { pattern: "/contact", view: "form", contentType: "msg" },
      ],
    } satisfies SubmissionManifestShape;
    const refused: string[] = [];
    const kept = allowedPublicRoutes(manifest, manifest.publicRoutes, (r) =>
      refused.push(r.view),
    );
    expect(kept.map((r) => r.pattern)).toEqual(["/contact"]);
    expect(refused.sort()).toEqual(["detail", "list"]);
  });

  it("leaves a normal content type's public routes completely alone", () => {
    // 迴歸護欄:過濾只能作用在 submission 上。
    const manifest = {
      contentTypes: [{ name: "post" }],
      publicRoutes: [
        { pattern: "/blog", view: "list", contentType: "post" },
        { pattern: "/blog/:slug", view: "detail", contentType: "post" },
      ],
    } satisfies SubmissionManifestShape;
    expect(allowedPublicRoutes(manifest, manifest.publicRoutes)).toHaveLength(2);
  });
});

// ---- 3b. auto-CRUD 表面收窄 ──────────────────────────────────────────────

describe("submission CRUD surface", () => {
  const ct = CONTACT_MANIFEST.contentTypes[0] as unknown as DeclarativeContentType;
  const sig = (isSubmission: boolean): string[] =>
    buildCrudRoutes("contact", ct, isSubmission).map(
      (r) => `${r.method} ${r.path}`,
    );

  it("drops the revision routes and adds the inbox route", () => {
    const routes = sig(true);
    // 訊息不可變 → 不留版本歷史(留下來的每筆快照都只是同一份訊息的副本)。
    expect(routes.some((r) => r.includes("revisions"))).toBe(false);
    expect(routes).toContain("PATCH submission/:id/inbox");
    // GET / DELETE 保留 —— DELETE 正是 schedule[] 180 天清理所走的路徑。
    expect(routes).toContain("GET submission/:id");
    expect(routes).toContain("DELETE submission/:id");
    expect(routes).toContain("POST submission");
  });

  it("answers 403 immutable_submission on PUT", async () => {
    const put = buildCrudRoutes("contact", ct, true).find(
      (r) => r.method === "PUT",
    );
    expect(put).toBeDefined();
    const res = await put!.handler(
      new Request(`${ORIGIN}/x`, { method: "PUT" }),
      { id: "abc" },
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "immutable_submission" });
  });

  it("leaves a normal content type's CRUD surface unchanged", () => {
    const routes = sig(false);
    expect(routes).toContain("PUT submission/:id");
    expect(routes).toContain("GET submission/:id/revisions");
    expect(routes.some((r) => r.includes("/inbox"))).toBe(false);
  });
});

// ---- 4. 公開 Content API:收件內容不可觸及 ────────────────────────────────

describe("submissions are not reachable through the Content API", () => {
  async function token(): Promise<string> {
    const created = await createApiToken("test");
    return created.raw;
  }

  it("404s the list endpoint for a submission type", async () => {
    await insertDx("contact", CONTACT_MANIFEST);
    await insertContent({
      id: "s1",
      type: CONTACT_TYPE,
      status: "draft",
      data: { name: "Ada", email: "ada@example.com", message: "hello" },
    });
    const res = await contentApiGet(
      new Request(`${ORIGIN}/api/content/contact/submission`, {
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      apiParams("contact", "submission"),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    // 不只是「沒有列」—— 連欄位值都不能出現在回應裡。
    expect(body).not.toContain("ada@example.com");
    expect(body).not.toContain("Ada");
  });

  it("404s the detail endpoint for a submission type", async () => {
    await insertDx("contact", CONTACT_MANIFEST);
    await insertContent({
      id: "s2",
      type: CONTACT_TYPE,
      slug: "ada",
      status: "draft",
      data: { name: "Ada", email: "ada@example.com" },
    });
    const res = await contentApiGet(
      new Request(`${ORIGIN}/api/content/contact/submission/ada`, {
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      apiParams("contact", "submission", ["ada"]),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("ada@example.com");
  });

  it("still 404s even if a submission row is somehow marked published", async () => {
    // 這一條測的是**型別層**的擋牆,而不是 published-only 篩選 —— 兩層防線各測各的。
    // 若哪天有人拿掉型別擋牆,這個測試會紅;若哪天有人弄壞 status 篩選,上面兩條會紅。
    await insertDx("contact", CONTACT_MANIFEST);
    await insertContent({
      id: "s3",
      type: CONTACT_TYPE,
      slug: "leaked",
      status: "published",
      data: { name: "Ada", email: "ada@example.com", message: "secret" },
    });
    const t = await token();
    const list = await contentApiGet(
      new Request(`${ORIGIN}/api/content/contact/submission`, {
        headers: { Authorization: `Bearer ${t}` },
      }),
      apiParams("contact", "submission"),
    );
    expect(list.status).toBe(404);
    expect(await list.text()).not.toContain("secret");

    const detail = await contentApiGet(
      new Request(`${ORIGIN}/api/content/contact/submission/leaked`, {
        headers: { Authorization: `Bearer ${t}` },
      }),
      apiParams("contact", "submission", ["leaked"]),
    );
    expect(detail.status).toBe(404);
    expect(await detail.text()).not.toContain("secret");
  });

  it("still serves a normal published content type", async () => {
    // 迴歸護欄:擋牆只能擋 submission。
    await insertDx("blog", {
      id: "blog",
      name: "Blog",
      version: "1.0.0",
      coreApi: "^1.0.0",
      contentTypes: [
        { name: "post", fields: [{ key: "title", type: "text", label: "T" }] },
      ],
    });
    await insertContent({
      id: "p1",
      type: "blog.post",
      slug: "hello",
      status: "published",
      data: { title: "Hello" },
    });
    const res = await contentApiGet(
      new Request(`${ORIGIN}/api/content/blog/post`, {
        headers: { Authorization: `Bearer ${await token()}` },
      }),
      apiParams("blog", "post"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(1);
  });
});

// ---- 5. publish-due 永遠不碰收件列 ────────────────────────────────────────

describe("publish-due never touches a submission", () => {
  it("leaves a submission draft even when publish_at is due", async () => {
    const past = Date.now() - 60_000;
    // 收件列:有到期的 publish_at(模擬手改 DB / 未來某條路徑誤設),且側表有紀錄。
    await insertContent({
      id: "sub-1",
      type: CONTACT_TYPE,
      status: "draft",
      publishAt: past,
      data: { email: "ada@example.com" },
    });
    await stampNewSubmission("sub-1", CONTACT_TYPE);
    // 對照組:一般內容的到期草稿,必須照常被發佈。
    await insertContent({
      id: "post-1",
      type: "blog.post",
      status: "draft",
      publishAt: past,
      data: { title: "Hello" },
    });

    const reports = await runDueJobs(Date.now());
    const publishDue = reports.find((r) => r.id === "publish-due");
    expect(publishDue?.ok).toBe(true);
    expect(publishDue?.processed).toBe(1); // 只有那篇文章

    const sub = await d1()
      .prepare("SELECT status, publish_at FROM contents WHERE id = 'sub-1'")
      .first<{ status: string; publish_at: number | null }>();
    expect(sub?.status).toBe("draft");
    expect(sub?.publish_at).toBe(past); // 連 publish_at 都沒被清掉:根本沒被選中

    const post = await d1()
      .prepare("SELECT status FROM contents WHERE id = 'post-1'")
      .first<{ status: string }>();
    expect(post?.status).toBe("published");
  });
});

// ---- 6. 收件狀態機 ────────────────────────────────────────────────────────

describe("inbox state", () => {
  it("reads a legacy submission with no side-table row as unread", async () => {
    // 上線前既有的 contact 提交:contents 有列、側表沒有。零 backfill。
    await insertContent({
      id: "old-1",
      type: CONTACT_TYPE,
      status: "draft",
      data: { name: "Legacy" },
    });
    const { items, total } = await listSubmissions(CONTACT_TYPE, {
      state: "unread",
    });
    expect(total).toBe(1);
    expect(items[0].state).toBe("unread");
    expect(items[0].repliedAt).toBeNull();

    const counts = await submissionCounts(CONTACT_TYPE);
    expect(counts).toEqual({ unread: 1, read: 0, archived: 0, total: 1 });
  });

  it("moves through unread → read → archived and filters accordingly", async () => {
    await insertContent({ id: "m1", type: CONTACT_TYPE, status: "draft" });
    await stampNewSubmission("m1", CONTACT_TYPE);

    expect((await submissionCounts(CONTACT_TYPE)).unread).toBe(1);

    expect(await setSubmissionState(CONTACT_TYPE, "m1", "read")).toBe(true);
    let counts = await submissionCounts(CONTACT_TYPE);
    expect(counts).toEqual({ unread: 0, read: 1, archived: 0, total: 1 });
    expect((await listSubmissions(CONTACT_TYPE, { state: "unread" })).total).toBe(0);
    expect((await listSubmissions(CONTACT_TYPE, { state: "read" })).total).toBe(1);

    expect(await setSubmissionState(CONTACT_TYPE, "m1", "archived")).toBe(true);
    counts = await submissionCounts(CONTACT_TYPE);
    expect(counts).toEqual({ unread: 0, read: 0, archived: 1, total: 1 });
  });

  it("records a reply without losing it when the message is archived", async () => {
    // 這正是「已回覆」不做成第四個狀態的理由:歸檔不該抹掉「有人回過這個人」。
    await insertContent({ id: "m2", type: CONTACT_TYPE, status: "draft" });
    await stampNewSubmission("m2", CONTACT_TYPE);

    expect(await setSubmissionReplied(CONTACT_TYPE, "m2", true)).toBe(true);
    let items = (await listSubmissions(CONTACT_TYPE)).items;
    expect(items[0].repliedAt).not.toBeNull();
    // 回了信就不該還顯示未讀 —— 唯一一個安全的自動推進。
    expect(items[0].state).toBe("read");

    await setSubmissionState(CONTACT_TYPE, "m2", "archived");
    items = (await listSubmissions(CONTACT_TYPE)).items;
    expect(items[0].state).toBe("archived");
    expect(items[0].repliedAt).not.toBeNull();

    expect(await setSubmissionReplied(CONTACT_TYPE, "m2", false)).toBe(true);
    items = (await listSubmissions(CONTACT_TYPE)).items;
    expect(items[0].repliedAt).toBeNull();
  });

  it("refuses to change state for an id belonging to another type", async () => {
    await insertContent({ id: "p2", type: "blog.post", status: "draft" });
    expect(await setSubmissionState(CONTACT_TYPE, "p2", "read")).toBe(false);
    expect(await setSubmissionReplied(CONTACT_TYPE, "p2", true)).toBe(false);
  });

  it("keeps the 180-day purge working: retention delete removes the inbox record too", async () => {
    // contact 宣告的 schedule[] deleteOlderThan 走 provider.delete。側表雖已宣告
    // ON DELETE CASCADE,但 D1 是否開啟 FK enforcement 不在本層掌控內(revisions
    // 也為了同一個理由明確再刪一次),所以清理路徑會明確刪一次 —— 這條測試證明
    // 那次明確刪除確實發生,而不是仰賴一個可能沒被開啟的 PRAGMA。
    await insertContent({ id: "old-2", type: CONTACT_TYPE, status: "draft" });
    await stampNewSubmission("old-2", CONTACT_TYPE);
    expect(
      (
        await d1()
          .prepare("SELECT COUNT(*) AS n FROM content_submissions")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);

    await d1().prepare("DELETE FROM contents WHERE id = 'old-2'").run();
    await deleteSubmissionRecord("old-2");

    const left = await d1()
      .prepare("SELECT COUNT(*) AS n FROM content_submissions WHERE content_id = 'old-2'")
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
