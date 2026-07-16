import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// users 管理 API 的 binding-backed 整合測試(miniflare D1)。
// 重點在 PATCH /api/users/[id](/admin/users 編輯 sidebar 的後端):
// 欄位白名單(.strict())、自我降權防呆、404、password 走 hashPassword 管線。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies);
// role gating 語意與真實版一致:未登入 401、role 不符 403。
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

import { PATCH, DELETE } from "../src/app/api/users/[id]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

function patchReq(id: string, body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  for (const u of [ADMIN, EDITOR]) {
    await d1()
      .prepare(
        "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, ?, 1000)",
      )
      .bind(u.id, u.email, u.name, u.role)
      .run();
  }
  authState.user = ADMIN;
});

describe("PATCH /api/users/[id] — guards", () => {
  it("403 on cross-origin", async () => {
    const res = await PATCH(
      patchReq(EDITOR.id, { name: "X" }, "https://evil.test"),
      params(EDITOR.id),
    );
    expect(res.status).toBe(403);
  });

  it("401 unauthenticated / 403 non-admin", async () => {
    authState.user = null;
    expect(
      (await PATCH(patchReq(EDITOR.id, { name: "X" }), params(EDITOR.id)))
        .status,
    ).toBe(401);
    authState.user = EDITOR;
    expect(
      (await PATCH(patchReq(ADMIN.id, { name: "X" }), params(ADMIN.id)))
        .status,
    ).toBe(403);
  });

  it("400 on empty patch, unknown keys (strict), email smuggling, short password", async () => {
    for (const body of [
      {},
      { nope: 1 },
      { email: "new@test.com" },
      { password: "short" },
    ]) {
      const res = await PATCH(patchReq(EDITOR.id, body), params(EDITOR.id));
      expect(res.status).toBe(400);
    }
  });

  it("400 cannot_change_own_role; 404 unknown user", async () => {
    const own = await PATCH(
      patchReq(ADMIN.id, { role: "editor" }),
      params(ADMIN.id),
    );
    expect(own.status).toBe(400);
    expect(((await own.json()) as { error: string }).error).toBe(
      "cannot_change_own_role",
    );

    const missing = await PATCH(
      patchReq("u-ghost", { name: "X" }),
      params("u-ghost"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/users/[id] — updates", () => {
  it("updates name + role on another user and returns the row sans hash", async () => {
    const res = await PATCH(
      patchReq(EDITOR.id, { name: "Promoted", role: "admin" }),
      params(EDITOR.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toEqual({
      id: EDITOR.id,
      email: EDITOR.email,
      name: "Promoted",
      role: "admin",
      avatarKey: null,
    });
    expect("passwordHash" in body.user).toBe(false);
  });

  it("same-value own role is a no-op success; own name change allowed", async () => {
    const res = await PATCH(
      patchReq(ADMIN.id, { role: "admin", name: "Renamed" }),
      params(ADMIN.id),
    );
    expect(res.status).toBe(200);
    const row = await d1()
      .prepare("SELECT name FROM users WHERE id = ?")
      .bind(ADMIN.id)
      .first<{ name: string }>();
    expect(row?.name).toBe("Renamed");
  });

  it("password change rewrites password_hash via hashPassword", async () => {
    const before = await d1()
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(EDITOR.id)
      .first<{ password_hash: string }>();
    const res = await PATCH(
      patchReq(EDITOR.id, { password: "newpass-123" }),
      params(EDITOR.id),
    );
    expect(res.status).toBe(200);
    const after = await d1()
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(EDITOR.id)
      .first<{ password_hash: string }>();
    expect(after?.password_hash).not.toBe(before?.password_hash);
    expect(after?.password_hash.length).toBeGreaterThan(20);
  });
});

describe("DELETE /api/users/[id] — regression", () => {
  it("400 on self, 200 removes another user", async () => {
    const delReq = (id: string) =>
      new Request(`${ORIGIN}/api/users/${id}`, {
        method: "DELETE",
        headers: { Origin: ORIGIN },
      });
    expect((await DELETE(delReq(ADMIN.id), params(ADMIN.id))).status).toBe(
      400,
    );
    expect((await DELETE(delReq(EDITOR.id), params(EDITOR.id))).status).toBe(
      200,
    );
    const n = await d1()
      .prepare("SELECT COUNT(*) AS n FROM users")
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
