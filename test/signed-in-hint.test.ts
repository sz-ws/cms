import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.0:存起來的公開頁(例如結帳頁)要決定「值不值得問伺服器這位訪客是誰」。session cookie 是
// HttpOnly,瀏覽器讀不到,所以登入時旁邊多設一個瀏覽器讀得到的提示 cookie(只有 "1",不帶身分),
// 登出時一起清掉。提示只決定要不要問;是不是登入照舊由伺服器說了算。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

type Cookie = { value: string; options?: Record<string, unknown> };
// readOnly:Server Component 裡的 cookies() 不能寫,Next 會丟錯。
const jar = vi.hoisted(() => ({ map: new Map<string, Cookie>(), readOnly: false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const found = jar.map.get(name);
      return found ? { name, value: found.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (jar.readOnly) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      jar.map.set(name, { value, options });
    },
    delete: (name: string) => {
      if (jar.readOnly) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      jar.map.delete(name);
    },
  }),
}));

import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSessionAccess,
  setSessionCookies,
} from "../src/lib/auth";
import { SIGNED_IN_HINT_COOKIE, hasSignedInHint } from "../src/lib/signed-in-hint";

const d1 = () => (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.com', 'x', 'U1', 'guest', 0);",
  );
});

beforeEach(async () => {
  jar.map.clear();
  jar.readOnly = false;
  await d1().exec("DELETE FROM sessions;");
});

/** 只有 session cookie、沒有提示:改版前登入的會員,或自己設 session cookie 的外掛。 */
async function sessionWithoutHint(): Promise<void> {
  const token = await createSession("u1");
  jar.map.set(SESSION_COOKIE, { value: token });
}

describe("signed-in hint cookie", () => {
  it("is set next to the session at sign-in, readable by the browser and carrying no identity", async () => {
    setSessionCookies(await cookies(), "raw-token");
    const session = jar.map.get(SESSION_COOKIE);
    const hint = jar.map.get(SIGNED_IN_HINT_COOKIE);
    expect(session?.value).toBe("raw-token");
    expect(session?.options?.httpOnly).toBe(true);
    expect(hint?.value).toBe("1");
    expect(hint?.options?.httpOnly).toBe(false);
    expect(hint?.options?.maxAge).toBe(session?.options?.maxAge);
    expect(hint?.options?.path).toBe("/");
  });

  it("is cleared with the session at sign-out", async () => {
    const token = await createSession("u1");
    setSessionCookies(await cookies(), token);
    await destroySession();
    expect(jar.map.has(SESSION_COOKIE)).toBe(false);
    expect(jar.map.has(SIGNED_IN_HINT_COOKIE)).toBe(false);
  });

  it("is read from document.cookie", () => {
    expect(hasSignedInHint("")).toBe(false);
    expect(hasSignedInHint("theme=dark")).toBe(false);
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=1`)).toBe(true);
    expect(hasSignedInHint(`theme=dark; ${SIGNED_IN_HINT_COOKIE}=1; cart=x`)).toBe(true);
    expect(hasSignedInHint(`x${SIGNED_IN_HINT_COOKIE}=1`)).toBe(false);
    expect(hasSignedInHint(`${SIGNED_IN_HINT_COOKIE}=`)).toBe(false);
  });

  it("is added on a request whose session is valid but carries no hint", async () => {
    await sessionWithoutHint();
    const session = await getSessionAccess();
    expect(session?.user.id).toBe("u1");
    const hint = jar.map.get(SIGNED_IN_HINT_COOKIE);
    expect(hint?.value).toBe("1");
    expect(hint?.options?.httpOnly).toBe(false);
    expect(hint?.options?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("is left alone when the session is valid and the hint is there", async () => {
    await sessionWithoutHint();
    jar.map.set(SIGNED_IN_HINT_COOKIE, { value: "1" });
    await getSessionAccess();
    expect(jar.map.get(SIGNED_IN_HINT_COOKIE)?.options).toBeUndefined();
  });

  it("is cleared when the browser carries it but the session is gone", async () => {
    jar.map.set(SESSION_COOKIE, { value: "unknown-token" });
    jar.map.set(SIGNED_IN_HINT_COOKIE, { value: "1" });
    expect(await getSessionAccess()).toBeNull();
    expect(jar.map.has(SIGNED_IN_HINT_COOKIE)).toBe(false);
  });

  it("is cleared when the browser carries it with no session cookie at all", async () => {
    jar.map.set(SIGNED_IN_HINT_COOKIE, { value: "1" });
    expect(await getSessionAccess()).toBeNull();
    expect(jar.map.has(SIGNED_IN_HINT_COOKIE)).toBe(false);
  });

  it("is cleared when the session has expired", async () => {
    await sessionWithoutHint();
    jar.map.set(SIGNED_IN_HINT_COOKIE, { value: "1" });
    await d1().exec("UPDATE sessions SET expires_at = 1;");
    expect(await getSessionAccess()).toBeNull();
    expect(jar.map.has(SIGNED_IN_HINT_COOKIE)).toBe(false);
  });

  it("does not break a render that cannot set cookies (Server Component)", async () => {
    await sessionWithoutHint();
    jar.readOnly = true;
    const session = await getSessionAccess();
    expect(session?.user.id).toBe("u1");
    expect(jar.map.has(SIGNED_IN_HINT_COOKIE)).toBe(false);
  });
});
