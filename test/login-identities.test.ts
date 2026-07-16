import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// spec-login-providers.md §6/§9:帳號頁 identities API 整合測試(binding-backed D1)。
// requireAuth 用真實實作(只 mock next/headers cookies 注入 token + 真 session 列);
// @/lib/oidc 被 mock(避開 listLoginProviders 的 settings→loader 鏈;SENTINEL 常數
// 與真實一致 "!oauth-only",供 DELETE 的「最後登入方式」guard)。

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

vi.mock("@/lib/oidc", () => ({
  SENTINEL_PASSWORD_HASH: "!oauth-only",
  listLoginProviders: async () => [{ id: "google-login", label: "使用 Google 繼續" }],
  listUserIdentities: async () => [
    { id: "id-1", provider: "google-login", display: "u@test.com", createdAt: 1, lastUsedAt: null },
  ],
}));

import { createSession } from "../src/lib/auth";
import { GET as identitiesGET } from "../src/app/api/account/identities/route";
import { DELETE as identityDELETE } from "../src/app/api/account/identities/[id]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;
const ORIGIN = "https://cms.test";

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM sessions;");
  await d1().exec("DELETE FROM user_identities;");
  await d1().exec("DELETE FROM passkeys;");
  cookieState.token = null;
});

async function seedUser(
  id: string,
  role: "admin" | "editor" | "guest",
  passwordHash: string,
): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(id, `${id}@test.com`, passwordHash, id, role, Date.now())
    .run();
}
async function loginAs(id: string): Promise<void> {
  cookieState.token = await createSession(id);
}
async function addIdentity(idtyId: string, userId: string, sub: string): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO user_identities (id, user_id, provider, provider_user_id, display, created_at) VALUES (?1, ?2, 'google-login', ?3, 'd', ?4)",
    )
    .bind(idtyId, userId, sub, Date.now())
    .run();
}
async function addPasskey(userId: string): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO passkeys (id, user_id, public_key, name, created_at) VALUES (?1, ?2, 'pk', 'my key', ?3)",
    )
    .bind(`pk-${userId}`, userId, Date.now())
    .run();
}
function delReq(id: string, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/account/identities/${id}`, {
    method: "DELETE",
    headers: { Origin: origin },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/account/identities", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await identitiesGET();
    expect(res.status).toBe(401);
  });

  it("allows a guest (account-self endpoint) and returns identities + providers", async () => {
    await seedUser("g", "guest", "hash");
    await loginAs("g");
    const res = await identitiesGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identities: unknown[]; providers: unknown[] };
    expect(Array.isArray(body.identities)).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
  });
});

describe("DELETE /api/account/identities/[id]", () => {
  it("rejects a bad origin (403)", async () => {
    await seedUser("e", "editor", "hash");
    await loginAs("e");
    await addIdentity("id-x", "e", "sub-x");
    const res = await identityDELETE(delReq("id-x", "https://evil.test"), ctx("id-x"));
    expect(res.status).toBe(403);
  });

  it("deletes the caller's own identity (200)", async () => {
    await seedUser("e", "editor", "hash");
    await loginAs("e");
    await addIdentity("id-own", "e", "sub-own");
    const res = await identityDELETE(delReq("id-own"), ctx("id-own"));
    expect(res.status).toBe(200);
    const row = await d1()
      .prepare("SELECT count(*) c FROM user_identities WHERE id = 'id-own'")
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("returns 404 when deleting another user's identity", async () => {
    await seedUser("e", "editor", "hash");
    await seedUser("other", "editor", "hash");
    await addIdentity("id-other", "other", "sub-other");
    await loginAs("e");
    const res = await identityDELETE(delReq("id-other"), ctx("id-other"));
    expect(res.status).toBe(404);
    // 未被刪除。
    const row = await d1()
      .prepare("SELECT count(*) c FROM user_identities WHERE id = 'id-other'")
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("blocks removing the last login method for an OAuth-only user (400)", async () => {
    await seedUser("oauth", "guest", "!oauth-only");
    await loginAs("oauth");
    await addIdentity("id-last", "oauth", "sub-last");
    const res = await identityDELETE(delReq("id-last"), ctx("id-last"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("last_login_method");
    // 仍在。
    const row = await d1()
      .prepare("SELECT count(*) c FROM user_identities WHERE id = 'id-last'")
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("allows an OAuth-only user to remove one identity when another remains", async () => {
    await seedUser("oauth2", "guest", "!oauth-only");
    await loginAs("oauth2");
    await addIdentity("id-a", "oauth2", "sub-a");
    await addIdentity("id-b", "oauth2", "sub-b");
    const res = await identityDELETE(delReq("id-a"), ctx("id-a"));
    expect(res.status).toBe(200);
  });

  it("allows an OAuth-only user with a passkey to remove the last identity", async () => {
    await seedUser("oauth3", "guest", "!oauth-only");
    await loginAs("oauth3");
    await addIdentity("id-solo", "oauth3", "sub-solo");
    await addPasskey("oauth3");
    const res = await identityDELETE(delReq("id-solo"), ctx("id-solo"));
    expect(res.status).toBe(200);
  });

  it("allows a password user to remove their last identity (not oauth-only)", async () => {
    await seedUser("pw", "guest", "pbkdf2$600000$abc$def");
    await loginAs("pw");
    await addIdentity("id-pw", "pw", "sub-pw");
    const res = await identityDELETE(delReq("id-pw"), ctx("id-pw"));
    expect(res.status).toBe(200);
  });
});
