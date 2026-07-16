import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// spec-login-providers.md §3/§9:requireAuth 的「最低門檻」語意 —— 真實 requireAuth +
// getSessionUser(不 mock),只把 next/headers 的 cookies() mock 成可注入 token 的
// store,並用真 D1 session/user 列。驗證層級:admin > editor > guest。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// cookies() mock:回一個能讀 currentToken 的最小 store(getSessionUser 只用 .get)。
const cookieState = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && cookieState.token ? { value: cookieState.token } : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

import { requireAuth, createSession, AuthError } from "../src/lib/auth";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM sessions;");
  cookieState.token = null;
});

async function seedAndLogin(role: "admin" | "editor" | "guest"): Promise<string> {
  const id = `u-${role}`;
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?1, ?2, 'x', ?3, ?4, ?5)",
    )
    .bind(id, `${role}@test.com`, role, role, Date.now())
    .run();
  cookieState.token = await createSession(id);
  return id;
}

async function status(minRole?: "admin" | "editor" | "guest"): Promise<number> {
  try {
    await requireAuth(minRole);
    return 200;
  } catch (e) {
    if (e instanceof AuthError) return e.status;
    throw e;
  }
}

describe("requireAuth minimum-role semantics", () => {
  it("401 when unauthenticated", async () => {
    expect(await status()).toBe(401);
    expect(await status("guest")).toBe(401);
  });

  it("guest passes requireAuth('guest') but is 403 for the default (editor) and admin", async () => {
    await seedAndLogin("guest");
    expect(await status("guest")).toBe(200);
    expect(await status()).toBe(403); // default minRole = editor
    expect(await status("editor")).toBe(403);
    expect(await status("admin")).toBe(403);
  });

  it("editor passes default + editor + guest, 403 for admin", async () => {
    await seedAndLogin("editor");
    expect(await status()).toBe(200);
    expect(await status("editor")).toBe(200);
    expect(await status("guest")).toBe(200);
    expect(await status("admin")).toBe(403);
  });

  it("admin passes every level", async () => {
    await seedAndLogin("admin");
    expect(await status("admin")).toBe(200);
    expect(await status("editor")).toBe(200);
    expect(await status("guest")).toBe(200);
  });
});
