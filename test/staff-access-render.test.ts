import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { ReactElement } from "react";

// 1.50.0:自訂角色在「頁面」這一側的兩件事,staff-access.test.ts 沒涵蓋到:
//   1. 頁面守門開的門(React cache() 裡的盒子)要被同一個 request 裡、守門之後才
//      render 的子元件看到 —— 插件頁的子元件常自己再 requireAuth("admin")。這裡把
//      react 的 cache 換成 React server build 的語意(同一個 request、同樣的參數 →
//      同一個結果;換 request 就重來),真的跑守門,再 render 子元件。
//   2. migration 0021 還沒套用就部署時,登入的 request 不能全部 500。

// React server build 的 cache():每個 RSC request 一份。newRequest() = 下一個 request。
const requestCache = vi.hoisted(() => ({ memo: new Map<unknown, Map<string, unknown>>() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const cache =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      let byArgs = requestCache.memo.get(fn);
      if (!byArgs) {
        byArgs = new Map();
        requestCache.memo.set(fn, byArgs);
      }
      const key = JSON.stringify(args);
      if (!byArgs.has(key)) byArgs.set(key, fn(...args));
      return byArgs.get(key) as R;
    };
  return { ...actual, cache };
});
function newRequest(): void {
  requestCache.memo = new Map();
}

// migration 0021 前的 D1:任何碰到 staff_roles / staff_role_id 的查詢都像正式站那樣失敗。
const dbState = vi.hoisted(() => ({ before0021: false }));
function withoutStaffRoles(db: D1Database): D1Database {
  const missing = () => Promise.reject(new Error("D1_ERROR: no such table: staff_roles: SQLITE_ERROR"));
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (!/staff_role/i.test(sql)) return target.prepare(sql);
          const statement = { bind: () => statement, all: missing, raw: missing, first: missing, run: missing };
          return statement;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => {
    const db = (env as { DB: D1Database }).DB;
    return dbState.before0021 ? withoutStaffRoles(db) : db;
  },
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const cookieState = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && cookieState.token ? { value: cookieState.token } : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const seen = vi.hoisted(() => ({ renders: [] as string[] }));

vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { defineExtension } = await import("../src/ext/types");
  const { requireAuth } = await import("../src/lib/auth");
  const { canEditCurrentPage } = await import("../src/lib/access-guards");
  // 插件頁的子元件:自己再 requireAuth("admin"),再問能不能改(收起寫入按鈕用)。
  async function Workspace() {
    const user = await requireAuth("admin");
    seen.renders.push(`${user.role}:${(await canEditCurrentPage()) ? "edit" : "view"}`);
    return null;
  }
  const ext = defineExtension({
    id: "demo",
    name: "demo",
    version: "0.0.1",
    coreApi: "^1.50.0",
    adminPages: [
      { slug: "orders", title: "訂單", component: Workspace },
      { slug: "promos", title: "優惠碼", component: Workspace },
    ],
  });
  const rt = {
    enabled: [ext],
    all: [ext],
    hooks: new HookBus(),
    byId: (id: string) => (id === "demo" ? ext : undefined),
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return { getExtRuntime: async () => rt };
});

import {
  AuthError,
  createSession,
  getSessionUser,
  isMissingStaffRoles,
  requireAuth,
} from "../src/lib/auth";
import ExtAdminPage from "../src/app/(admin)/admin/ext/[extId]/[[...page]]/page";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT REFERENCES staff_roles(id) ON DELETE SET NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM sessions;");
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM staff_roles;");
  cookieState.token = null;
  dbState.before0021 = false;
  seen.renders = [];
  newRequest();
});

async function login(role: "admin" | "editor" | "guest", staffRoleId: string | null = null) {
  const id = `u-${role}-${staffRoleId ?? "preset"}`;
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, staff_role_id) VALUES (?1, ?2, 'x', ?3, ?4, 1, ?5)",
    )
    .bind(id, `${id}@test.com`, id, role, staffRoleId)
    .run();
  cookieState.token = await createSession(id);
}

async function loginWithRole(access: Record<string, string>) {
  await d1()
    .prepare("INSERT INTO staff_roles (id, name, access, created_at, updated_at) VALUES ('clerk', 'clerk', ?1, 1, 1)")
    .bind(JSON.stringify(access))
    .run();
  await login("guest", "clerk");
}

/** 一個 RSC request:頁面(守門)先跑,回傳的元素之後才 render —— 同一個 request。 */
async function renderPage(slug: string): Promise<void> {
  newRequest();
  const element = (await ExtAdminPage({
    params: Promise.resolve({ extId: "demo", page: [slug] }),
    searchParams: Promise.resolve({}),
  })) as ReactElement<Record<string, unknown>>;
  const Component = element.type as (props: Record<string, unknown>) => Promise<unknown>;
  await Component(element.props);
}

async function status(run: () => Promise<unknown>): Promise<number | string> {
  try {
    await run();
    return 200;
  } catch (e) {
    if (e instanceof AuthError) return e.status;
    if (e instanceof Error) return e.message;
    throw e;
  }
}

describe("a granted page's child components (one RSC request)", () => {
  it("see the role as admin inside the page, and whether it can edit there", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit", "/admin/ext/demo/promos": "view" });
    await renderPage("orders");
    await renderPage("promos");
    expect(seen.renders).toEqual(["admin:edit", "admin:view"]);
  });

  it("the door stays with its request: the next request outside the page is not admin", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit" });
    await renderPage("orders");
    newRequest();
    expect((await getSessionUser())?.role).toBe("editor");
    expect(await status(() => requireAuth("admin"))).toBe(403);
  });

  it("an ungranted page never renders its children", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit" });
    expect(await status(() => renderPage("promos"))).toBe("NEXT_NOT_FOUND");
    expect(seen.renders).toEqual([]);
  });

  it("presets are unchanged: admin edits, editor is refused", async () => {
    await login("admin");
    await renderPage("orders");
    expect(seen.renders).toEqual(["admin:edit"]);
    cookieState.token = null;
    await login("editor");
    expect(await status(() => renderPage("orders"))).toBe(403);
  });
});

describe("before migration 0021 is applied", () => {
  it("signed-in requests keep working with each user's stored role", async () => {
    await login("admin");
    dbState.before0021 = true;
    newRequest();
    const user = await getSessionUser();
    expect(user?.role).toBe("admin");
    expect(user?.staffRole).toBeUndefined();
    expect(await status(() => requireAuth("admin"))).toBe(200);
  });

  it("only a missing staff_roles table or column counts; other errors still surface", () => {
    const wrapped = new Error("Failed query: select ...", {
      cause: new Error("D1_ERROR: no such column: users.staff_role_id: SQLITE_ERROR"),
    });
    expect(isMissingStaffRoles(wrapped)).toBe(true);
    expect(isMissingStaffRoles(new Error("D1_ERROR: no such table: sessions: SQLITE_ERROR"))).toBe(false);
    expect(isMissingStaffRoles("no such table: staff_roles")).toBe(false);
  });
});
