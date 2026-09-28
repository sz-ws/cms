import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.59.0:GET /api/users/export 的 binding-backed 整合測試(miniflare D1)。
// 守門(只有管理員)、條件跟畫面同一份(users-filter.ts)、不分頁、CSV 的 BOM 與跳脫、
// 時間照站台時區。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);門檻語意與真實版
// 一致:未登入 401、低於門檻 403。自訂角色的人在 core API 裡是 "editor"(沒有開門,
// 見 lib/access-scope.ts)。
const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    role: "admin" | "editor" | "guest";
    staffRole?: { id: string; name: string };
  },
}));
const ROLE_RANK: Record<string, number> = { guest: 1, editor: 2, admin: 3 };
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (minRole: "admin" | "editor" | "guest" = "editor") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (ROLE_RANK[authState.user.role] < ROLE_RANK[minRole]) throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// 後台語言與站台時區(settings 由各自的測試覆蓋)。
vi.mock("@/lib/i18n/server", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/i18n/server")>()),
  getLocale: async () => "zh-Hant",
}));
vi.mock("@/lib/datetime-server", async () => {
  const { createDateFormatter } = await import("@/lib/datetime");
  return {
    getSiteTimeZone: async () => "Asia/Taipei",
    getDateFormatter: async (locale?: "en" | "zh-Hant") => createDateFormatter(locale ?? "zh-Hant", "Asia/Taipei"),
  };
});

// 1.60.0:啟用中的插件(預設沒有)與它們的 services;facet 的測試放一個假插件進來。
const runtime = vi.hoisted(() => ({ exts: [] as unknown[], services: [] as string[] }));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({ enabled: runtime.exts }) }));
vi.mock("@/ext/services", () => ({
  createServices: async (extId: string) => {
    runtime.services.push(extId);
    return { scope: extId };
  },
}));

import { GET } from "../src/app/api/users/export/route";
import { loadUsers } from "../src/app/(admin)/admin/users/users-data";
import type { Extension, MemberFacetContext } from "../src/ext/types";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const taipei = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin", role: "admin" as const };
const EDITOR = { id: "u-editor", email: "editor@example.com", name: "Editor", role: "editor" as const };
const CLERK = { id: "u-clerk", email: "clerk@example.com", name: "Clerk", role: "guest" as const };
const CLERK_SESSION = { ...CLERK, role: "editor" as const, staffRole: { id: "r-clerk", name: "門市人員" } };
const MEMBER_SESSION = { id: "m-ming", email: "Ming@Example.com", name: "王小明", role: "guest" as const };

function get(query = ""): Promise<Response> {
  return GET(new Request(`${ORIGIN}/api/users/export${query}`));
}

/**
 * CSV → 列(測試資料沒有換行,逗號都在引號內)。Response.text() 解 UTF-8 時會吃掉 BOM,
 * BOM 本身在「is a UTF-8 CSV with a BOM」用位元組驗。
 */
function parseCsv(text: string): string[][] {
  return text
    .replace(/^\ufeff/, "")
    .split("\r\n")
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replaceAll('""', '"')));
}

async function csv(query = ""): Promise<string[][]> {
  const res = await get(query);
  expect(res.status).toBe(200);
  return parseCsv(await res.text());
}

async function insertUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: number;
  staffRoleId?: string | null;
}): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, staff_role_id) VALUES (?, ?, 'x', ?, ?, ?, ?)",
    )
    .bind(u.id, u.email, u.name, u.role, u.createdAt, u.staffRoleId ?? null)
    .run();
}

async function signIn(userId: string, at: number): Promise<void> {
  await d1()
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(`s-${userId}-${at}`, userId, at + 86_400_000, at)
    .run();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
});

beforeEach(async () => {
  for (const table of ["sessions", "passkeys", "users", "staff_roles"]) await d1().exec(`DELETE FROM ${table};`);
  await d1()
    .prepare("INSERT INTO staff_roles (id, name, access, created_at, updated_at) VALUES ('r-clerk', '門市人員', '{}', 1, 1)")
    .run();
  await insertUser({ ...ADMIN, createdAt: taipei(2026, 1, 10, 9) });
  await insertUser({ ...EDITOR, createdAt: taipei(2026, 3, 5) });
  await insertUser({ ...CLERK, createdAt: taipei(2026, 6, 1), staffRoleId: "r-clerk" });
  // 會員:一位有登入過、一位要測跳脫與公式注入、一位是第三方登入拿不到 email 的。
  await insertUser({ id: "m-ming", email: "Ming@Example.com", name: "王小明", role: "guest", createdAt: taipei(2026, 9, 1, 0, 5) });
  await insertUser({ id: "m-quote", email: "quote@example.com", name: '=HYPERLINK("x") "Q", Ltd', role: "guest", createdAt: taipei(2026, 8, 31, 23, 59) });
  await insertUser({ id: "m-line", email: "oauth-line-abcd1234@placeholder.invalid", name: "Line User", role: "guest", createdAt: taipei(2026, 9, 15) });
  await signIn("m-ming", taipei(2026, 9, 20, 8));
  await signIn("m-ming", taipei(2026, 9, 28, 14, 5));
  await signIn(CLERK.id, taipei(2026, 9, 1, 0, 30));
  authState.user = ADMIN;
  runtime.exts = [];
  runtime.services = [];
});

describe("GET /api/users/export — access", () => {
  it("401 when signed out, 403 for staff, custom roles and members", async () => {
    authState.user = null;
    expect((await get()).status).toBe(401);
    for (const user of [EDITOR, CLERK_SESSION, MEMBER_SESSION]) {
      authState.user = user;
      const res = await get("?view=members");
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("example.com");
    }
  });
});

describe("GET /api/users/export — file", () => {
  it("is a UTF-8 CSV with a BOM, named after the group and today's date", async () => {
    const res = await get("?view=members");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const staff = await get();
    expect(staff.headers.get("Content-Disposition")).toMatch(/filename="staff-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it("writes the owner's columns: name, email, role names, joined and last active in the site time zone", async () => {
    const staff = await csv();
    expect(staff[0]).toEqual(["姓名", "Email", "角色", "加入時間", "最近上線"]);
    expect(staff.slice(1)).toEqual([
      ["Admin", "admin@example.com", "管理員", "2026-01-10 09:00:00", ""],
      ["Editor", "editor@example.com", "工作人員", "2026-03-05 00:00:00", ""],
      ["Clerk", "clerk@example.com", "門市人員", "2026-06-01 00:00:00", "2026-09-01 00:30:00"],
    ]);
    const members = await csv("?view=members");
    expect(members.slice(1).map((row) => row.slice(0, 2))).toEqual([
      ['\'=HYPERLINK("x") "Q", Ltd', "quote@example.com"],
      ["王小明", "Ming@Example.com"],
      // 合成的 placeholder email 不寫出去。
      ["Line User", ""],
    ]);
    // 最近上線是最近一次登入。
    expect(members[2]?.[4]).toBe("2026-09-28 14:05:00");
  });

  it("escapes quotes and blocks formulas", async () => {
    const text = await (await get("?view=members&q=ltd")).text();
    expect(text).toContain('"\'=HYPERLINK(""x"") ""Q"", Ltd"');
  });
});

describe("GET /api/users/export — the same conditions as the page", () => {
  it("applies search, dates and role", async () => {
    const names = async (query: string) => (await csv(query)).slice(1).map((row) => row[0]);
    expect(await names("?view=members&q=example.COM")).toEqual(['\'=HYPERLINK("x") "Q", Ltd', "王小明"]);
    expect(await names("?view=members&q=placeholder")).toEqual([]);
    expect(await names("?view=members&joinedFrom=2026-09-01")).toEqual(["王小明", "Line User"]);
    expect(await names("?view=members&joinedTo=2026-08-31")).toEqual(['\'=HYPERLINK("x") "Q", Ltd']);
    expect(await names("?view=members&activeFrom=2026-09-21&activeTo=2026-09-28")).toEqual(["王小明"]);
    expect(await names("?activeFrom=2026-09-01&activeTo=2026-09-01")).toEqual(["Clerk"]);
    expect(await names("?role=role:r-clerk")).toEqual(["Clerk"]);
    expect(await names("?role=admin,editor")).toEqual(["Admin", "Editor"]);
    // 會員這組沒有角色篩選。
    expect(await names("?view=members&role=admin")).toHaveLength(3);
  });

  it("ignores values it does not know instead of failing", async () => {
    const rows = await csv("?view=members&joinedFrom=not-a-day&role=bogus&activeTo=2026-02-31");
    expect(rows).toHaveLength(4);
  });

  it("an empty result is just the header", async () => {
    const rows = await csv("?q=nobody-by-this-name");
    expect(rows).toEqual([["姓名", "Email", "角色", "加入時間", "最近上線"]]);
  });

  it("exports every matching row, not one page", async () => {
    const stmt = d1().prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, 'guest', ?)",
    );
    await d1().batch(
      Array.from({ length: 150 }, (_, i) =>
        stmt.bind(`bulk-${i}`, `bulk-${i}@example.net`, `Bulk ${i}`, taipei(2026, 7, 1) + i),
      ),
    );
    const all = await csv("?view=members");
    expect(all).toHaveLength(1 + 3 + 150);
    const bulk = await csv("?view=members&q=example.net");
    expect(bulk).toHaveLength(1 + 150);
    expect(bulk[1]?.[0]).toBe("Bulk 0");
    expect(bulk[150]?.[0]).toBe("Bulk 149");
  });
});

// 1.60.0:一個假插件宣告一個 facet(會員等級)。成員頁與匯出讀同一份(users-data.ts):
// 每個人的 facet、欄位、篩選的網址參數、CSV 的欄。
describe("member facets from a plugin", () => {
  const seen: { ids: string[]; ctx: MemberFacetContext }[] = [];
  const loyalty = (): Extension => ({
    id: "loyalty",
    name: "Loyalty",
    version: "1.0.0",
    coreApi: "^1.60.0",
    memberFacets: [
      {
        id: "tier",
        label: { "zh-Hant": "會員等級", en: "Tier" },
        read: async (ids, ctx) => {
          seen.push({ ids, ctx });
          return {
            "m-ming": { badge: "Gold", lines: [{ label: "點數", value: "120" }] },
            [ADMIN.id]: { badge: "Staff" },
          };
        },
        actions: [
          { label: { "zh-Hant": "加入會員等級", en: "Enrol" }, when: "missing", href: (id) => `/admin/ext/loyalty/new?member=${id}` },
        ],
      },
    ],
  });

  beforeEach(() => {
    seen.length = 0;
    runtime.exts = [loyalty()];
  });

  it("lists each person's facet for the page, read once with every id and the plugin's services", async () => {
    const data = await loadUsers({ locale: "zh-Hant", timeZone: "Asia/Taipei" });
    expect(data.facets).toEqual([{ key: "loyalty.tier", label: "會員等級" }]);
    expect(seen).toHaveLength(1);
    expect([...seen[0].ids].sort()).toEqual(data.users.map((u) => u.id).sort());
    expect(seen[0].ctx).toEqual({ services: { scope: "loyalty" }, locale: "zh-Hant", timeZone: "Asia/Taipei" });
    const byId = new Map(data.users.map((u) => [u.id, u]));
    expect(byId.get("m-ming")?.facets).toEqual({
      "loyalty.tier": { value: { badge: "Gold", lines: [{ label: "點數", value: "120" }] }, actions: [] },
    });
    expect(byId.get("m-line")?.facets).toEqual({
      "loyalty.tier": { actions: [{ label: "加入會員等級", href: "/admin/ext/loyalty/new?member=m-line" }] },
    });
  });

  it("adds the facet column to the CSV and filters by it the same way as the page", async () => {
    const members = await csv("?view=members");
    expect(members[0]).toEqual(["姓名", "Email", "角色", "加入時間", "最近上線", "會員等級"]);
    expect(members.slice(1).map((row) => [row[0], row[5]])).toEqual([
      ['\'=HYPERLINK("x") "Q", Ltd', ""],
      ["王小明", "Gold"],
      ["Line User", ""],
    ]);
    const names = async (query: string) => (await csv(query)).slice(1).map((row) => row[0]);
    expect(await names("?view=members&loyalty.tier=has")).toEqual(["王小明"]);
    expect(await names("?view=members&loyalty.tier=missing")).toEqual(['\'=HYPERLINK("x") "Q", Ltd', "Line User"]);
    expect(await names("?loyalty.tier=has")).toEqual(["Admin"]);
  });

  it("drops a broken facet and keeps the export working", async () => {
    runtime.exts = [
      {
        ...loyalty(),
        memberFacets: [
          {
            id: "tier",
            label: "會員等級",
            read: async () => {
              throw new Error("boom");
            },
          },
        ],
      },
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const members = await csv("?view=members&loyalty.tier=has");
      // 讀壞的 facet 沒有欄,篩選也不算數。
      expect(members[0]).toEqual(["姓名", "Email", "角色", "加入時間", "最近上線"]);
      expect(members).toHaveLength(4);
      expect(String(errors.mock.calls[0]?.[0])).toContain('ext="loyalty" facet="tier" read failed');
    } finally {
      errors.mockRestore();
    }
  });

  it("does not ask for services when no plugin has facets", async () => {
    runtime.exts = [{ id: "plain", name: "Plain", version: "1.0.0", coreApi: "^1.60.0" }];
    const data = await loadUsers({ locale: "zh-Hant", timeZone: "Asia/Taipei" });
    expect(data.facets).toEqual([]);
    expect(data.users.every((u) => u.facets === undefined)).toBe(true);
    expect(runtime.services).toEqual([]);
  });
});
