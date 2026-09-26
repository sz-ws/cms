import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.56.0 上新通知:GET / POST /api/registry/notice(binding-backed,miniflare D1)。
//   - 開關預設關:沒有來源打開時,不碰資料庫,也不對外連線
//   - 只有預設的管理員看得到(editor 被 requireAuth 擋下;自訂角色回 null)
//   - 快取沒有或超過 12 小時才讀一次 registry.json;12 小時內再進後台不再連線(連不上也一樣)
//   - publishedAt 早於 noticesSince 的不跳;每位管理員各記一次;24 小時內最多一則
// registry 以 stub 的 fetch 代替;getCloudflareContext 丟錯 → route 直接等背景工作做完。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no worker context in tests");
  },
}));

type TestUser = { id: string; email: string; name: string; role: "admin" | "editor"; staffRole?: { id: string; name: string } };
const authState = vi.hoisted(() => ({ user: null as TestUser | null }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role === "admin" && authState.user.role !== "admin") throw new actual.AuthError(403);
      return authState.user;
    },
  };
});
vi.mock("@/lib/security", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/security")>();
  return { ...actual, assertSameOrigin: () => {} };
});

const sourcesState = vi.hoisted(() => ({ sources: [] as unknown[] }));
vi.mock("@/lib/settings", () => ({
  getSetting: async () => sourcesState.sources,
  getRegistryTokenMap: async () => ({}),
}));

import { GET, POST } from "../src/app/api/registry/notice/route";

const d1 = () => (env as { DB: D1Database }).DB;
const HOUR = 60 * 60 * 1000;

const ADMIN: TestUser = { id: "admin-1", email: "a@example.com", name: "A", role: "admin" };
const OTHER_ADMIN: TestUser = { id: "admin-2", email: "b@example.com", name: "B", role: "admin" };

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * HOUR).toISOString().slice(0, 10);

let sourceSeq = 0;
/** 每個測試用自己的來源網址:快取與「看過」都以來源為鍵,互不影響。 */
function freshSource(options: { notices?: boolean; since?: string } = {}): string {
  const url = `https://notices-${++sourceSeq}.example.com`;
  sourcesState.sources = [
    {
      url,
      ...(options.notices === false ? {} : { notices: true, noticesSince: options.since ?? new Date(Date.now() - 30 * 24 * HOUR).toISOString() }),
    },
  ];
  return url;
}

const index = (notices: unknown[]) => ({
  extensions: [{ id: "session-replay", kind: "declarative", name: "工作階段錄影", version: "0.1.0", coreApi: "^1.0.0", banner: "banner.png" }],
  notices,
});
const notice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `新服務 ${id}`,
  body: "看訪客在頁面上怎麼捲動。",
  extension: "session-replay",
  publishedAt: daysAgo(1),
  ...extra,
});

function serve(body: () => unknown): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body()), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

async function shown(): Promise<{ id: string; source: string; extensionName: string } | null> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { notice: { id: string; source: string; extensionName: string } | null }).notice;
}

const seen = (source: string, id: string) =>
  POST(
    new Request("https://cms.test/api/registry/notice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, id }),
    }),
  );

beforeAll(async () => {
  await d1().batch(
    [
      "CREATE TABLE IF NOT EXISTS registry_notices (source TEXT PRIMARY KEY NOT NULL, notices TEXT NOT NULL, fetched_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS registry_notice_seen (user_id TEXT NOT NULL, source TEXT NOT NULL, notice_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (user_id, source, notice_id));",
    ].map((sql) => d1().prepare(sql)),
  );
});
beforeEach(async () => {
  authState.user = ADMIN;
  // 「一天一則」看的是這位管理員看過的任何一則,每個測試從乾淨的紀錄開始。
  await d1().prepare("DELETE FROM registry_notice_seen").run();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("off unless a source turns it on", () => {
  it("no source with notices: nothing is shown and nothing is fetched", async () => {
    freshSource({ notices: false });
    const calls = serve(() => index([notice("a")]));
    expect(await shown()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("who sees it", () => {
  it("an editor is turned away", async () => {
    freshSource();
    const calls = serve(() => index([notice("a")]));
    authState.user = { ...ADMIN, role: "editor" };
    expect((await GET()).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("a custom role acting as admin gets nothing", async () => {
    freshSource();
    const calls = serve(() => index([notice("a")]));
    authState.user = { ...ADMIN, staffRole: { id: "r1", name: "Staff" } };
    expect(await shown()).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await seen("https://x.example.com", "a")).status).toBe(403);
  });
});

describe("fetching", () => {
  it("the first visit fills the cache; the next one shows the notice without fetching again", async () => {
    const source = freshSource();
    const calls = serve(() => index([notice("a")]));
    expect(await shown()).toBeNull();
    expect(calls).toEqual([`${source}/registry.json`]);
    const n = await shown();
    expect(n).toMatchObject({ id: "a", source, extensionName: "工作階段錄影" });
    expect(calls).toHaveLength(1);
  });

  it("a registry that cannot be reached is not tried again for 12 hours", async () => {
    const source = freshSource();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    expect(await shown()).toBeNull();
    const calls = serve(() => index([notice("a")]));
    expect(await shown()).toBeNull();
    expect(calls).toHaveLength(0);
    // 12 小時後再試。
    await d1().prepare("UPDATE registry_notices SET fetched_at = ?1 WHERE source = ?2").bind(Date.now() - 13 * HOUR, source).run();
    await shown();
    expect(calls).toHaveLength(1);
  });
});

describe("which notice", () => {
  it("nothing published before the switch was turned on", async () => {
    freshSource({ since: new Date().toISOString() });
    serve(() => index([notice("old", { publishedAt: daysAgo(3) })]));
    await shown();
    expect(await shown()).toBeNull();
  });

  it("once per admin: seen by one, still shown to another", async () => {
    const source = freshSource();
    serve(() => index([notice("a")]));
    await shown();
    expect((await shown())?.id).toBe("a");
    expect((await seen(source, "a")).status).toBe(204);
    expect(await shown()).toBeNull();
    authState.user = OTHER_ADMIN;
    expect((await shown())?.id).toBe("a");
  });

  it("at most one a day", async () => {
    const source = freshSource();
    serve(() => index([notice("a", { publishedAt: daysAgo(1) }), notice("b", { publishedAt: daysAgo(2) })]));
    await shown();
    expect((await shown())?.id).toBe("a");
    await seen(source, "a");
    expect(await shown()).toBeNull();
    await d1()
      .prepare("UPDATE registry_notice_seen SET seen_at = ?1 WHERE user_id = ?2")
      .bind(Date.now() - 25 * HOUR, ADMIN.id)
      .run();
    expect((await shown())?.id).toBe("b");
  });

  it("seen is only recorded for a source with notices on and a well-formed id", async () => {
    const source = freshSource();
    expect((await seen("https://not-configured.example.com", "a")).status).toBe(400);
    expect((await seen(source, "Not An Id")).status).toBe(400);
    const { results } = await d1().prepare("SELECT * FROM registry_notice_seen").all();
    expect(results).toHaveLength(0);
  });
});
