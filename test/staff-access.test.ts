import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.50.0:自訂角色的強制執行 —— 真的 requireAuth / getSessionUser(D1 session +
// staff_roles),只 mock cookies() 注入 token。驗四件事:
//   1. 只有檢視權的角色寫入 → 403,handler 不會被呼叫。
//   2. 沒授權的後台頁 → 404(notFound)。
//   3. 管理者不受影響。
//   4. 編輯者與 1.49.0 相同(requireAuth 最低門檻、插件 API、後台頁一律照舊)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
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

// notFound / redirect 在 Next 裡是丟特殊錯誤;這裡丟看得出是哪一個的錯誤。
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

vi.mock("@/ext/services", () => ({ createServices: async () => ({}) }));

// 儀表板的落點要側欄;側欄要整個 extension runtime —— 給一份固定的群組。
vi.mock("@/lib/admin-nav", () => ({
  getFullAdminNavGroups: async () => [
    { id: "workspace", label: "工作區", items: [{ href: "/admin", title: "儀表板", kind: "core" }] },
    {
      id: "commerce",
      label: "商務",
      items: [
        { href: "/admin/ext/demo/orders", title: "訂單", kind: "extension" },
        { href: "/admin/ext/demo/promos", title: "優惠碼", kind: "extension" },
      ],
    },
  ],
}));

const calls = vi.hoisted(() => ({ handled: [] as string[] }));

vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { defineExtension } = await import("../src/ext/types");
  const { requireAuth, getSessionUser } = await import("../src/lib/auth");
  const { withinAdminPage } = await import("../src/lib/access-scope");
  // handler 自己再 requireAuth("admin") —— 訂單類插件常這樣寫。
  const adminHandler = (label: string) => async () => {
    const actor = await requireAuth("admin");
    calls.handled.push(`${label}:${actor.role}`);
    return Response.json({ ok: true });
  };
  // 不看角色的 handler(commerce-kit 的運費、優惠碼就是這樣):只靠 dispatch 的門。
  const plainHandler = (label: string) => async () => {
    calls.handled.push(label);
    return Response.json({ ok: true });
  };
  const ext = defineExtension({
    id: "demo",
    name: "demo",
    version: "0.0.1",
    coreApi: "^1.50.0",
    adminPages: [
      { slug: "orders", title: "訂單", component: () => null },
      { slug: "orders/detail", title: "訂單明細", showInMenu: false, accessAs: "demo/orders", component: () => null },
      { slug: "promos", title: "優惠碼", component: () => null },
      { slug: "secret", title: "隱藏頁", showInMenu: false, component: () => null },
    ],
    apiRoutes: [
      { method: "GET", path: "orders", accessAs: "demo/orders", handler: adminHandler("orders:get") },
      { method: "POST", path: "orders", accessAs: "demo/orders", handler: adminHandler("orders:post") },
      { method: "POST", path: "promos", accessAs: "demo/promos", handler: plainHandler("promos:post") },
      { method: "POST", path: "anything", handler: plainHandler("anything:post") },
      // 一條 route 服務兩頁(收款與出貨共用一條 actions 那種):handler 依動作縮到那一頁。
      {
        method: "POST",
        path: "desk/:page",
        handler: async (_req, params) => {
          const actor = await withinAdminPage(`demo/${params.page}`, () => requireAuth("admin"));
          calls.handled.push(`desk:${params.page}:${actor.role}`);
          return Response.json({ ok: true });
        },
      },
      {
        method: "GET",
        path: "account",
        public: true,
        handler: async () => {
          const who = await getSessionUser();
          calls.handled.push(`account:${who?.role ?? "anonymous"}`);
          return Response.json({ role: who?.role ?? null });
        },
      },
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

import { requireAuth, createSession, AuthError, getSessionUser } from "../src/lib/auth";
import { runWithAccessScope, withinAdminPage } from "../src/lib/access-scope";
import {
  adminPageLevels,
  requireExtensionAccess,
  requireMediaAccess,
  type MediaAction,
} from "../src/lib/access-api";
import { guardDashboard, guardExtAdminPage } from "../src/lib/access-guards";
import { GET, POST } from "../src/app/api/ext/[extId]/[[...path]]/route";
import ExtAdminPage from "../src/app/(admin)/admin/ext/[extId]/[[...page]]/page";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const ORIGIN = "https://cms.test";

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
  calls.handled = [];
});

async function addRole(id: string, access: Record<string, string>): Promise<void> {
  await d1()
    .prepare("INSERT INTO staff_roles (id, name, access, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)")
    .bind(id, id, JSON.stringify(access))
    .run();
}

async function login(
  role: "admin" | "editor" | "guest",
  staffRoleId: string | null = null,
): Promise<void> {
  const id = `u-${role}-${staffRoleId ?? "preset"}`;
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, staff_role_id) VALUES (?1, ?2, 'x', ?3, ?4, 1, ?5)",
    )
    .bind(id, `${id}@test.com`, id, role, staffRoleId)
    .run();
  cookieState.token = await createSession(id);
}

/** 指派自訂角色的樣子:users.role 寫 guest、staff_role_id 指向角色。 */
async function loginWithRole(access: Record<string, string>): Promise<void> {
  await addRole("clerk", access);
  await login("guest", "clerk");
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

function call(method: "GET" | "POST", path: string): Promise<Response> {
  const handler = method === "GET" ? GET : POST;
  return handler(
    new Request(`${ORIGIN}/api/ext/demo/${path}`, {
      method,
      headers: method === "POST" ? { origin: ORIGIN, "content-type": "application/json" } : {},
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
    { params: Promise.resolve({ extId: "demo", path: path.split("/") }) },
  );
}

function openPage(page: string[]): Promise<unknown> {
  return ExtAdminPage({
    params: Promise.resolve({ extId: "demo", page }),
    searchParams: Promise.resolve({}),
  });
}

describe("requireAuth with a custom role", () => {
  it("outside any granted page or API the role is a signed-in editor-level user", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit" });
    const user = await getSessionUser();
    expect(user?.role).toBe("editor");
    expect(user?.staffRole).toEqual({ id: "clerk", name: "clerk" });
    expect(await status(() => requireAuth("admin"))).toBe(403);
    expect(await status(() => requireAuth())).toBe(200);
  });

  it("inside a scope it runs as admin only when the role's level is enough", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view" });
    const scope = (needed: "view" | "edit") => ({ needed, levelOf: () => "view" as const });
    expect(await runWithAccessScope(scope("view"), () => status(() => requireAuth("admin")))).toBe(200);
    expect(await runWithAccessScope(scope("edit"), () => status(() => requireAuth("admin")))).toBe(403);
  });

  it("a deleted role falls back to the stored guest role", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit" });
    await d1().exec("UPDATE users SET staff_role_id = NULL;");
    const user = await getSessionUser();
    expect(user?.role).toBe("guest");
    expect(user?.staffRole).toBeUndefined();
  });
});

describe("extension API dispatch", () => {
  it("a view-only role reads, runs as admin inside the handler, and gets 403 on a write", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view" });
    expect((await call("GET", "orders")).status).toBe(200);
    expect((await call("POST", "orders")).status).toBe(403);
    expect(calls.handled).toEqual(["orders:get:admin"]);
  });

  it("an edit grant on one page does not open another page's API", async () => {
    await loginWithRole({ "/admin/ext/demo/promos": "edit" });
    expect((await call("POST", "promos")).status).toBe(200);
    expect((await call("POST", "orders")).status).toBe(403);
    expect((await call("GET", "orders")).status).toBe(403);
    // 沒宣告 accessAs 的 route:這個 extension 任一頁的最高權限。
    expect((await call("POST", "anything")).status).toBe(200);
    expect(calls.handled).toEqual(["promos:post", "anything:post"]);
  });

  it("a role with no access to the extension gets 403 everywhere but public routes", async () => {
    await loginWithRole({ "/admin/media": "edit" });
    expect((await call("POST", "anything")).status).toBe(403);
    expect((await call("GET", "account")).status).toBe(200);
    // 公開 route 裡它是一般登入者,不是管理者。
    expect(calls.handled).toEqual(["account:editor"]);
  });

  it("public routes run as admin only for a role with access", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view" });
    await call("GET", "account");
    expect(calls.handled).toEqual(["account:admin"]);
  });

  it("admin is unaffected", async () => {
    await login("admin");
    expect((await call("POST", "orders")).status).toBe(200);
    expect((await call("POST", "promos")).status).toBe(200);
    expect(calls.handled).toEqual(["orders:post:admin", "promos:post"]);
  });

  it("editor is unchanged: dispatch lets them in, admin-only handlers still refuse", async () => {
    await login("editor");
    expect((await call("POST", "promos")).status).toBe(200);
    expect((await call("POST", "anything")).status).toBe(200);
    // handler 自己的 requireAuth("admin") 照舊擋編輯者。
    expect(await status(() => call("POST", "orders").then(() => undefined))).toBe(403);
    expect(calls.handled).toEqual(["promos:post", "anything:post"]);
  });

  it("guest is unchanged: 403 on non-public routes", async () => {
    await login("guest");
    expect((await call("POST", "promos")).status).toBe(403);
    expect(calls.handled).toEqual([]);
  });
});

describe("admin pages", () => {
  it("a page the role cannot view is a 404; a granted one and its detail page open", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view" });
    expect(await status(() => openPage(["promos"]))).toBe("NEXT_NOT_FOUND");
    expect(await status(() => openPage(["secret"]))).toBe("NEXT_NOT_FOUND");
    expect(await status(() => openPage(["orders"]))).toBe(200);
    expect(await status(() => openPage(["orders", "detail"]))).toBe(200);
    const user = await guardExtAdminPage("demo", { slug: "orders" });
    expect(user.role).toBe("admin");
  });

  it("admin opens every page; editor still gets 403 like before", async () => {
    await login("admin");
    expect(await status(() => openPage(["secret"]))).toBe(200);
    cookieState.token = null;
    await login("editor");
    expect(await status(() => openPage(["orders"]))).toBe(403);
  });

  it("a role without the dashboard lands on its first page", async () => {
    await loginWithRole({ "/admin/ext/demo/promos": "view" });
    expect(await status(() => guardDashboard())).toBe("NEXT_REDIRECT:/admin/ext/demo/promos");
    await d1().exec(`UPDATE staff_roles SET access = '{"/admin":"view"}';`);
    expect(await status(() => guardDashboard())).toBe(200);
  });
});

describe("media API", () => {
  const media = (action: MediaAction) => status(() => requireMediaAccess(action));

  it("view on the library browses only; edit elsewhere also allows picking and uploading", async () => {
    await loginWithRole({ "/admin/media": "view" });
    expect([await media("browse"), await media("upload"), await media("manage")]).toEqual([200, 403, 403]);
    await d1().exec(`UPDATE staff_roles SET access = '{"/admin/ext/demo/promos":"edit"}';`);
    expect([await media("browse"), await media("upload"), await media("manage")]).toEqual([200, 200, 403]);
    await d1().exec(`UPDATE staff_roles SET access = '{"/admin/media":"edit"}';`);
    expect(await media("manage")).toBe(200);
  });

  it("presets are unchanged: admin only", async () => {
    await login("editor");
    expect(await media("browse")).toBe(403);
    cookieState.token = null;
    await login("admin");
    expect(await media("manage")).toBe(200);
  });
});

describe("extension-owned core data (status notes)", () => {
  it("follows the extension's highest level: view reads, edit writes, other extensions closed", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view" });
    expect(await status(() => requireExtensionAccess("demo", "view"))).toBe(200);
    expect(await status(() => requireExtensionAccess("demo", "edit"))).toBe(403);
    expect(await status(() => requireExtensionAccess("wallet", "view"))).toBe(403);
  });

  it("presets are unchanged: admin only", async () => {
    await login("editor");
    expect(await status(() => requireExtensionAccess("demo", "view"))).toBe(403);
  });
});

describe("narrowing a door to one page (withinAdminPage)", () => {
  /** dispatch 自己回的 403 是 Response;handler 裡 requireAuth 丟的是 AuthError。 */
  const code = (run: Promise<Response>) =>
    run.then((r) => r.status).catch((e) => (e instanceof AuthError ? e.status : Promise.reject(e)));

  it("a route serving two pages runs each action with that page's grant only", async () => {
    await loginWithRole({ "/admin/ext/demo/promos": "edit", "/admin/ext/demo/orders": "view" });
    expect(await code(call("POST", "desk/promos"))).toBe(200);
    // 訂單只有檢視:寫入縮到訂單頁就不是管理者了。
    expect(await code(call("POST", "desk/orders"))).toBe(403);
    expect(calls.handled).toEqual(["desk:promos:admin"]);
  });

  it("never widens: no outer door or a malformed page is closed, and the outer level still applies", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "edit" });
    expect(await status(() => withinAdminPage("demo/orders", () => requireAuth("admin")))).toBe(403);
    const door = (needed: "view" | "edit", level: "view" | "edit") => ({ needed, levelOf: () => level });
    expect(
      await runWithAccessScope(door("edit", "edit"), () =>
        status(() => withinAdminPage("Not A Page", () => requireAuth("admin"))),
      ),
    ).toBe(403);
    // 外層這扇門這個角色只到檢視:縮到一頁有編輯權的也不會變成能寫。
    expect(
      await runWithAccessScope(door("edit", "view"), () =>
        status(() => withinAdminPage("demo/orders", () => requireAuth("admin"))),
      ),
    ).toBe(403);
    expect(
      await runWithAccessScope(door("edit", "edit"), () =>
        status(() => withinAdminPage("demo/orders", () => requireAuth("admin"))),
      ),
    ).toBe(200);
  });

  it("presets are unaffected", async () => {
    await login("admin");
    expect(await code(call("POST", "desk/orders"))).toBe(200);
    expect(await status(() => withinAdminPage("demo/orders", () => requireAuth("admin")))).toBe(200);
    expect(calls.handled).toEqual(["desk:orders:admin"]);
  });
});

describe("adminPageLevels", () => {
  const pages = { orders: "demo/orders", promos: "demo/promos", secret: "demo/secret" } as const;

  it("reports a custom role's level per page", async () => {
    await loginWithRole({ "/admin/ext/demo/orders": "view", "/admin/ext/demo/promos": "edit" });
    const user = await requireAuth();
    expect(await adminPageLevels(user, pages)).toEqual({ orders: "view", promos: "edit", secret: "none" });
  });

  it("presets: admin can edit every page, editor none", async () => {
    await login("admin");
    expect(await adminPageLevels(await requireAuth(), pages)).toEqual({ orders: "edit", promos: "edit", secret: "edit" });
    cookieState.token = null;
    await login("editor");
    expect(await adminPageLevels(await requireAuth(), pages)).toEqual({ orders: "none", promos: "none", secret: "none" });
  });
});
