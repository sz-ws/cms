import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.50.0:角色與權限的 API —— POST/PATCH/DELETE /api/roles,與成員頁指派角色
// (PATCH /api/users/<id> 的 staffRoleId)。D1 真的寫;requireAuth 由測試控制。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const authState = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role) throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

import { POST as createRole } from "../src/app/api/roles/route";
import { PATCH as patchRole, DELETE as deleteRole } from "../src/app/api/roles/[id]/route";
import { PATCH as patchUser } from "../src/app/api/users/[id]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const ORIGIN = "https://cms.test";

const ADMIN = { id: "u-admin", email: "admin@test.com", name: "Admin", role: "admin" as const };

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function userRow(id: string) {
  return d1()
    .prepare("SELECT role, staff_role_id FROM users WHERE id = ?")
    .bind(id)
    .first<{ role: string; staff_role_id: string | null }>();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT REFERENCES staff_roles(id) ON DELETE SET NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM staff_roles;");
  for (const [id, role] of [
    [ADMIN.id, "admin"],
    ["u-staff", "editor"],
  ]) {
    await d1()
      .prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, ?, 1)")
      .bind(id, `${id}@test.com`, id, role)
      .run();
  }
  authState.user = ADMIN;
});

async function create(body: unknown): Promise<{ status: number; id?: string; error?: string }> {
  const res = await createRole(req("POST", "/api/roles", body));
  const json = (await res.json()) as { role?: { id: string }; error?: string };
  return { status: res.status, id: json.role?.id, error: json.error };
}

describe("roles API", () => {
  it("creates a role and keeps only grantable pages", async () => {
    const made = await create({
      name: " 會計 ",
      access: { "/admin/ext/order-desk/payments": "edit", "/admin/settings": "edit", "/admin": "edit" },
    });
    expect(made.status).toBe(201);
    const row = await d1()
      .prepare("SELECT name, access FROM staff_roles WHERE id = ?")
      .bind(made.id)
      .first<{ name: string; access: string }>();
    expect(row?.name).toBe("會計");
    expect(JSON.parse(row!.access)).toEqual({
      "/admin/ext/order-desk/payments": "edit",
      "/admin": "view",
    });
  });

  it("refuses a duplicate name, an empty name and unknown levels", async () => {
    expect((await create({ name: "會計", access: {} })).status).toBe(201);
    expect(await create({ name: "會計", access: {} })).toMatchObject({ status: 409, error: "name_taken" });
    expect((await create({ name: "  ", access: {} })).status).toBe(400);
    expect((await create({ name: "X", access: { "/admin/media": "owner" } })).status).toBe(400);
  });

  it("is admin-only", async () => {
    authState.user = { ...ADMIN, id: "u-staff", role: "editor" };
    expect((await create({ name: "X", access: {} })).status).toBe(403);
  });

  it("updates name and access", async () => {
    const { id } = await create({ name: "訂單", access: {} });
    const res = await patchRole(
      req("PATCH", `/api/roles/${id}`, { name: "訂單管理", access: { "/admin/ext/order-desk": "view" } }),
      params(id!),
    );
    expect(res.status).toBe(200);
    const row = await d1().prepare("SELECT name, access FROM staff_roles").first<{ name: string; access: string }>();
    expect(row?.name).toBe("訂單管理");
    expect(JSON.parse(row!.access)).toEqual({ "/admin/ext/order-desk": "view" });
    expect((await patchRole(req("PATCH", "/api/roles/nope", { name: "Y" }), params("nope"))).status).toBe(404);
  });

  it("deleting a role turns its members into guests", async () => {
    const { id } = await create({ name: "市場營銷", access: { "/admin/ext/shop/promos": "edit" } });
    expect((await patchUser(req("PATCH", "/api/users/u-staff", { staffRoleId: id }), params("u-staff"))).status).toBe(200);
    const res = await deleteRole(req("DELETE", `/api/roles/${id}`), params(id!));
    expect(await res.json()).toEqual({ ok: true, moved: 1 });
    expect(await userRow("u-staff")).toEqual({ role: "guest", staff_role_id: null });
    expect(await d1().prepare("SELECT COUNT(*) AS n FROM staff_roles").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("assigning roles to members", () => {
  it("a custom role stores guest + the role; a preset clears the role", async () => {
    const { id } = await create({ name: "會計", access: {} });
    await patchUser(req("PATCH", "/api/users/u-staff", { staffRoleId: id }), params("u-staff"));
    expect(await userRow("u-staff")).toEqual({ role: "guest", staff_role_id: id });
    await patchUser(req("PATCH", "/api/users/u-staff", { role: "editor" }), params("u-staff"));
    expect(await userRow("u-staff")).toEqual({ role: "editor", staff_role_id: null });
  });

  it("refuses an unknown role, both fields at once, and changing your own role", async () => {
    const { id } = await create({ name: "會計", access: {} });
    const unknown = await patchUser(req("PATCH", "/api/users/u-staff", { staffRoleId: "ghost" }), params("u-staff"));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("role_not_found");
    const both = await patchUser(
      req("PATCH", "/api/users/u-staff", { role: "admin", staffRoleId: id }),
      params("u-staff"),
    );
    expect(both.status).toBe(400);
    const own = await patchUser(req("PATCH", `/api/users/${ADMIN.id}`, { staffRoleId: id }), params(ADMIN.id));
    expect(((await own.json()) as { error: string }).error).toBe("cannot_change_own_role");
    expect(await userRow(ADMIN.id)).toEqual({ role: "admin", staff_role_id: null });
  });
});
