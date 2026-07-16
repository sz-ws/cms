import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// L1 §6:passkey glue 的 binding-backed 整合測試(miniflare D1)。
// WebAuthn 密碼學信任 lib —— mock @simplewebauthn/server 的 4 個函式,只測我們的 glue:
// challenge 單次性、DB 寫入、session 建立、rate limit、擁有權 gating、public_key 不外洩。

// 同既有測試:mock @/lib/cf 讓 getDB 直接回傳 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// getSetting("core.siteTitle") → 固定回傳,避免依賴 settings 表 / React cache。
vi.mock("@/lib/settings", () => ({
  getSetting: async (_key: string, fallback?: unknown) => fallback ?? "Test Site",
}));

// requireAuth / getSessionUser 由測試控制(pool-workers 無 request-scoped cookies)。
// createSession / sessionCookieOptions / SESSION_COOKIE 等維持真實(importActual)。
const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => {
      if (!authState.user) throw new actual.AuthError(401);
      return authState.user;
    },
    getSessionUser: async () => authState.user,
  };
});

// in-memory cookie store,讓 login/verify route 的 cookies().set 可跑。
const cookieStore = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => {
      const v = cookieStore.map.get(k);
      return v ? { name: k, value: v } : undefined;
    },
    set: (k: string, v: string) => {
      cookieStore.map.set(k, v);
    },
    delete: (k: string) => {
      cookieStore.map.delete(k);
    },
  }),
}));

// @simplewebauthn/server:4 個函式 mock,由每個 test 設定回傳值。
const wa = vi.hoisted(() => ({
  genRegOpts: vi.fn(),
  verifyReg: vi.fn(),
  genAuthOpts: vi.fn(),
  verifyAuth: vi.fn(),
}));
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: wa.genRegOpts,
  verifyRegistrationResponse: wa.verifyReg,
  generateAuthenticationOptions: wa.genAuthOpts,
  verifyAuthenticationResponse: wa.verifyAuth,
}));

import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
} from "@/lib/passkey";
import { POST as loginVerify } from "../src/app/api/auth/passkey/login/verify/route";
import { GET as listPasskeys } from "../src/app/api/auth/passkey/route";
import { DELETE as deletePasskey } from "../src/app/api/auth/passkey/[id]/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function clientDataJSON(challenge: string, type: string): string {
  const json = JSON.stringify({ type, challenge, origin: ORIGIN });
  return b64url(new TextEncoder().encode(json));
}

function authBody(credId: string, challenge: string) {
  return {
    id: credId,
    rawId: credId,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON(challenge, "webauthn.get"),
      authenticatorData: "AA",
      signature: "AA",
      userHandle: "AA",
    },
    clientExtensionResults: {},
  };
}

function regBody(challenge: string, extra?: Record<string, unknown>) {
  return {
    id: "ignored-lib-mocked",
    rawId: "ignored-lib-mocked",
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON(challenge, "webauthn.create"),
      attestationObject: "AA",
    },
    clientExtensionResults: {},
    ...extra,
  };
}

function makeReq(
  path: string,
  init?: { method?: string; body?: unknown; ip?: string; noOrigin?: boolean },
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!init?.noOrigin) headers["origin"] = ORIGIN;
  if (init?.ip) headers["cf-connecting-ip"] = init.ip;
  return new Request(`${ORIGIN}${path}`, {
    method: init?.method ?? "POST",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function seedUser(
  id: string,
  email: string,
  role: "admin" | "editor" = "admin",
): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, email, "x", email, role, Date.now())
    .run();
}

async function seedPasskey(
  id: string,
  userId: string,
  opts?: { publicKey?: string; counter?: number; transports?: string | null },
): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(
      id,
      userId,
      opts?.publicKey ?? "AQID",
      opts?.counter ?? 0,
      opts?.transports === undefined ? '["internal"]' : opts.transports,
      "Test Key",
      Date.now(),
    )
    .run();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS webauthn_challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM sessions;");
  await d1().exec("DELETE FROM passkeys;");
  await d1().exec("DELETE FROM webauthn_challenges;");
  await d1().exec("DELETE FROM login_attempts;");
  authState.user = null;
  cookieStore.map.clear();
  wa.genRegOpts.mockReset();
  wa.verifyReg.mockReset();
  wa.genAuthOpts.mockReset();
  wa.verifyAuth.mockReset();
});

// ---- §6.1:challenge 單次性 + 過期 ----

describe("challenge single-use (§6.1)", () => {
  it("second verify with same challenge → throws (consumed)", async () => {
    await seedUser("u1", "a@t.co");
    await seedPasskey("cred-1", "u1");
    wa.genAuthOpts.mockResolvedValue({ challenge: "authchal", allowCredentials: [] });
    wa.verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });

    await startAuthentication(makeReq("/api/auth/passkey/login/options"));
    const body = authBody("cred-1", "authchal");

    const user = await finishAuthentication(
      makeReq("/api/auth/passkey/login/verify"),
      body,
    );
    expect(user.id).toBe("u1");

    // 同一 challenge 第二次 → 已被單次消費 → throw。
    await expect(
      finishAuthentication(makeReq("/api/auth/passkey/login/verify"), body),
    ).rejects.toThrow();
  });

  it("expired challenge → throws", async () => {
    await seedUser("u1", "a@t.co");
    await seedPasskey("cred-1", "u1");
    wa.verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    // 直接塞一個過期的 auth challenge。
    await d1()
      .prepare(
        "INSERT INTO webauthn_challenges (id, kind, user_id, expires_at) VALUES (?, 'auth', NULL, ?)",
      )
      .bind("expired", Date.now() - 1000)
      .run();

    await expect(
      finishAuthentication(
        makeReq("/api/auth/passkey/login/verify"),
        authBody("cred-1", "expired"),
      ),
    ).rejects.toThrow();
  });
});

// ---- §6.2:register 寫入 passkeys + excludeCredentials ----

describe("registration (§6.2)", () => {
  it("writes passkey row with correct fields; excludeCredentials carried on next start", async () => {
    await seedUser("u1", "a@t.co");
    authState.user = { id: "u1", email: "a@t.co", name: "a@t.co", role: "admin" };

    wa.genRegOpts.mockResolvedValue({ challenge: "regchal" });
    wa.verifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal", "hybrid"],
        },
      },
    });

    await startRegistration(
      authState.user,
      makeReq("/api/auth/passkey/register/options"),
    );
    // 首次 start:excludeCredentials 為空。
    expect(wa.genRegOpts.mock.calls[0][0].excludeCredentials).toEqual([]);
    expect(wa.genRegOpts.mock.calls[0][0].rpID).toBe("cms.test");

    const created = await finishRegistration(
      authState.user,
      makeReq("/api/auth/passkey/register/verify"),
      regBody("regchal", { name: "My Laptop" }),
    );
    expect(created).toEqual({ id: "cred-1", name: "My Laptop" });

    const row = await d1()
      .prepare("SELECT * FROM passkeys WHERE id = 'cred-1'")
      .first<{
        user_id: string;
        public_key: string;
        counter: number;
        transports: string;
        name: string;
      }>();
    expect(row?.user_id).toBe("u1");
    // publicKey base64url([1,2,3]) = "AQID"
    expect(row?.public_key).toBe("AQID");
    expect(row?.counter).toBe(0);
    expect(JSON.parse(row!.transports)).toEqual(["internal", "hybrid"]);
    expect(row?.name).toBe("My Laptop");

    // 再次 start → excludeCredentials 帶到現有那把。
    await startRegistration(
      authState.user,
      makeReq("/api/auth/passkey/register/options"),
    );
    const exclude = wa.genRegOpts.mock.calls[1][0].excludeCredentials;
    expect(exclude).toEqual([
      { id: "cred-1", transports: ["internal", "hybrid"] },
    ]);
  });

  it("name falls back to UA inference when body.name absent", async () => {
    await seedUser("u1", "a@t.co");
    authState.user = { id: "u1", email: "a@t.co", name: "a@t.co", role: "admin" };
    wa.genRegOpts.mockResolvedValue({ challenge: "regchal2" });
    wa.verifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-ua",
          publicKey: new Uint8Array([9]),
          counter: 0,
          transports: undefined,
        },
      },
    });
    await startRegistration(
      authState.user,
      makeReq("/api/auth/passkey/register/options"),
    );
    const req = new Request(`${ORIGIN}/api/auth/passkey/register/verify`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });
    const created = await finishRegistration(
      authState.user,
      req,
      regBody("regchal2"),
    );
    expect(created.name).toBe("Chrome on Mac");
  });
});

// ---- §6.3:login verify 成功 → session 建立 + counter/last_used 更新 ----

describe("login verify success (§6.3)", () => {
  it("creates a session (cookie set) and updates counter + last_used_at", async () => {
    await seedUser("u1", "a@t.co");
    await seedPasskey("cred-1", "u1", { counter: 0 });
    wa.genAuthOpts.mockResolvedValue({ challenge: "authchal", allowCredentials: [] });
    wa.verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 42 },
    });

    await startAuthentication(makeReq("/api/auth/passkey/login/options"));

    const res = await loginVerify(
      makeReq("/api/auth/passkey/login/verify", {
        body: authBody("cred-1", "authchal"),
        ip: "5.5.5.5",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // session 建立(cookie 語意同 password 路徑:cookies().set 被呼叫)。
    expect(cookieStore.map.has("session")).toBe(true);
    const sess = await d1()
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1'")
      .first<{ n: number }>();
    expect(sess?.n).toBe(1);

    // counter / last_used_at 更新。
    const pk = await d1()
      .prepare("SELECT counter, last_used_at FROM passkeys WHERE id = 'cred-1'")
      .first<{ counter: number; last_used_at: number | null }>();
    expect(pk?.counter).toBe(42);
    expect(pk?.last_used_at).not.toBeNull();
  });
});

// ---- §6.4:未知 credential → 401;rate limit 第 11 次 → 429 ----

describe("login verify failures + rate limit (§6.4)", () => {
  it("unknown credential id → 401 passkey_failed", async () => {
    wa.genAuthOpts.mockResolvedValue({ challenge: "authchal", allowCredentials: [] });
    await startAuthentication(makeReq("/api/auth/passkey/login/options"));

    const res = await loginVerify(
      makeReq("/api/auth/passkey/login/verify", {
        body: authBody("nope", "authchal"),
        ip: "1.2.3.4",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "passkey_failed" });
  });

  it("11th attempt from same IP → 429", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await loginVerify(
        makeReq("/api/auth/passkey/login/verify", {
          body: authBody("nope", "x"),
          ip: "9.9.9.9",
        }),
      );
    }
    expect(last?.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "rate_limited" });
  });

  it("missing Origin → 403 (CSRF line)", async () => {
    const res = await loginVerify(
      makeReq("/api/auth/passkey/login/verify", {
        body: authBody("nope", "x"),
        noOrigin: true,
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ---- §6.5:DELETE 別人的 → 404;刪自己最後一把 → 200 ----

describe("delete ownership (§6.5)", () => {
  it("deleting someone else's passkey → 404; deleting own last one → 200", async () => {
    await seedUser("u1", "a@t.co");
    await seedUser("u2", "b@t.co", "editor");
    await seedPasskey("cred-1", "u1");
    await seedPasskey("cred-2", "u2");
    authState.user = { id: "u1", email: "a@t.co", name: "a@t.co", role: "admin" };

    // u1 試刪 u2 的 → 404(WHERE user_id 過濾,changes 0)。
    const other = await deletePasskey(
      makeReq("/api/auth/passkey/cred-2", { method: "DELETE" }),
      { params: Promise.resolve({ id: "cred-2" }) },
    );
    expect(other.status).toBe(404);

    // u1 刪自己(且是最後一把)→ 200(密碼 recovery,不自鎖)。
    const own = await deletePasskey(
      makeReq("/api/auth/passkey/cred-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "cred-1" }) },
    );
    expect(own.status).toBe(200);

    const remaining = await d1()
      .prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = 'u1'")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

// ---- §6.6:GET 不含 public_key ----

describe("list passkeys (§6.6)", () => {
  it("GET returns own passkeys without public_key", async () => {
    await seedUser("u1", "a@t.co");
    await seedUser("u2", "b@t.co", "editor");
    await seedPasskey("cred-1", "u1", { publicKey: "SECRETKEYMATERIAL" });
    await seedPasskey("cred-2", "u2");
    authState.user = { id: "u1", email: "a@t.co", name: "a@t.co", role: "admin" };

    const res = await listPasskeys();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeys: Array<Record<string, unknown>>;
    };
    // 只列自己的一把。
    expect(body.passkeys).toHaveLength(1);
    expect(body.passkeys[0].id).toBe("cred-1");
    expect(body.passkeys[0]).not.toHaveProperty("publicKey");
    expect(body.passkeys[0]).not.toHaveProperty("public_key");
    expect(JSON.stringify(body)).not.toContain("SECRETKEYMATERIAL");
  });

  it("GET without auth → 401", async () => {
    authState.user = null;
    const res = await listPasskeys();
    expect(res.status).toBe(401);
  });
});
