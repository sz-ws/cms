import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { env } from "cloudflare:test";

// spec-login-providers.md §9:core OIDC 引擎 binding-backed 測試(miniflare D1)。
// 外部 IdP fetch(discovery / token / jwks / userinfo)以 mock 的 global.fetch 提供;
// id_token 以測試內 WebCrypto 產的 key pair 簽(RS256 + ES256)。settings 以 in-memory
// map mock(避開 loader 鏈);declarative_extensions / users / identities / oauth_states
// 皆為真 D1 列。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// settings mock:in-memory,回明文(clientSecret 在真實中加密,測試不需驗加密管線)。
const settingsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/settings", () => ({
  getSetting: async <T>(key: string, fallback?: T): Promise<T> =>
    (settingsStore.has(key) ? (settingsStore.get(key) as unknown as T) : (fallback as T)),
  extSetting: (extId: string, key: string): string => `ext.${extId}.${key}`,
}));

import {
  beginOAuth,
  completeOAuth,
  listLoginProviders,
  listUserIdentities,
  __clearOidcCaches,
} from "../src/lib/oidc";
import { GOOGLE_LOGIN_MANIFEST } from "./login-provider-manifest.test";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const PROVIDER = "google-login";
const ISSUER = "https://oidc.test";
const CLIENT_ID = "client-abc";
const ORIGIN = "https://cms.test";

// ---- WebCrypto 簽章 helpers ----

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

let rsaKeys: CryptoKeyPair;
let ecKeys: CryptoKeyPair;
let jwksDoc: { keys: JsonWebKey[] };

async function signJwt(
  claims: Record<string, unknown>,
  alg: "RS256" | "ES256",
): Promise<string> {
  const kid = alg === "RS256" ? "rsa-1" : "ec-1";
  const priv = alg === "RS256" ? rsaKeys.privateKey : ecKeys.privateKey;
  const header = b64urlStr(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const params =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" };
  const sig = new Uint8Array(await crypto.subtle.sign(params, priv, data));
  return `${header}.${payload}.${b64url(sig)}`;
}

// ---- mock fetch(discovery / token / jwks / userinfo)----

const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

let tokenResponse: unknown = {};
let userinfoDoc: unknown = {};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  rsaKeys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  ecKeys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const rsaJwk = await crypto.subtle.exportKey("jwk", rsaKeys.publicKey);
  rsaJwk.kid = "rsa-1";
  rsaJwk.alg = "RS256";
  rsaJwk.use = "sig";
  const ecJwk = await crypto.subtle.exportKey("jwk", ecKeys.publicKey);
  ecJwk.kid = "ec-1";
  ecJwk.alg = "ES256";
  ecJwk.use = "sig";
  jwksDoc = { keys: [rsaJwk, ecJwk] };

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
    if (url.endsWith("/jwks")) return jsonResponse(jwksDoc);
    if (url.endsWith("/token")) return jsonResponse(tokenResponse);
    if (url.endsWith("/userinfo")) return jsonResponse(userinfoDoc);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  __clearOidcCaches();
  settingsStore.clear();
  settingsStore.set(`ext.${PROVIDER}.clientId`, CLIENT_ID);
  settingsStore.set(`ext.${PROVIDER}.clientSecret`, "secret-xyz");
  settingsStore.set("core.auth.oauthRegistration", "guest");
  tokenResponse = {};
  userinfoDoc = {};

  await d1().exec("DELETE FROM users;");
  await d1().exec("DELETE FROM user_identities;");
  await d1().exec("DELETE FROM oauth_states;");
  await d1().exec("DELETE FROM declarative_extensions;");

  // 插入 google-login declarative extension(issuer 覆寫為 mock 的 oidc.test)。
  const manifest = {
    ...GOOGLE_LOGIN_MANIFEST,
    loginProvider: { ...GOOGLE_LOGIN_MANIFEST.loginProvider, issuer: ISSUER },
  };
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, installed_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
    )
    .bind(PROVIDER, JSON.stringify(manifest), "1.0.0", Date.now())
    .run();
});

function req(): Request {
  return new Request(`${ORIGIN}/api/auth/oauth/${PROVIDER}/callback`, {
    headers: { Origin: ORIGIN },
  });
}

// begin → 解析 state/nonce → 簽 id_token → complete。claimOverride 可覆寫 claims。
async function runFlow(opts: {
  sub: string;
  email?: string;
  name?: string;
  alg?: "RS256" | "ES256";
  mode?: "login" | "link";
  userId?: string;
  claimOverride?: Record<string, unknown>;
  reuseState?: { state: string; nonce: string };
}): Promise<{ outcome: Awaited<ReturnType<typeof completeOAuth>>; state: string; nonce: string }> {
  const alg = opts.alg ?? "RS256";
  let state: string;
  let nonce: string;
  if (opts.reuseState) {
    ({ state, nonce } = opts.reuseState);
  } else {
    const begin = await beginOAuth({
      providerId: PROVIDER,
      mode: opts.mode ?? "login",
      userId: opts.userId,
      next: "/admin",
      req: req(),
    });
    if ("error" in begin) throw new Error(`beginOAuth failed: ${begin.error}`);
    const loc = new URL(begin.location);
    state = loc.searchParams.get("state")!;
    nonce = loc.searchParams.get("nonce")!;
  }

  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    sub: opts.sub,
    ...(opts.email ? { email: opts.email, email_verified: true } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...opts.claimOverride,
  };
  tokenResponse = { id_token: await signJwt(claims, alg), access_token: "at-1" };

  const outcome = await completeOAuth({
    providerId: PROVIDER,
    code: "auth-code",
    state,
    req: req(),
  });
  return { outcome, state, nonce };
}

async function seedUser(id: string, email: string, role = "editor"): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?1, ?2, 'x', ?3, ?4, ?5)",
    )
    .bind(id, email.toLowerCase(), "Name", role, Date.now())
    .run();
}

describe("listLoginProviders", () => {
  it("lists a configured provider", async () => {
    const list = await listLoginProviders();
    expect(list.map((p) => p.id)).toContain(PROVIDER);
    expect(list[0].label).toBe("使用 Google 繼續");
  });

  it("omits a provider missing clientId/clientSecret", async () => {
    settingsStore.delete(`ext.${PROVIDER}.clientSecret`);
    const list = await listLoginProviders();
    expect(list.map((p) => p.id)).not.toContain(PROVIDER);
  });
});

describe("beginOAuth", () => {
  it("stores a one-time state and returns the authorization URL", async () => {
    const begin = await beginOAuth({
      providerId: PROVIDER,
      mode: "login",
      next: "/admin",
      req: req(),
    });
    expect("location" in begin).toBe(true);
    if (!("location" in begin)) return;
    const loc = new URL(begin.location);
    expect(loc.origin + loc.pathname).toBe(`${ISSUER}/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/oauth/${PROVIDER}/callback`,
    );
    const row = await d1()
      .prepare("SELECT count(*) as c FROM oauth_states WHERE id = ?1")
      .bind(loc.searchParams.get("state"))
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("returns provider_unavailable when unconfigured", async () => {
    settingsStore.delete(`ext.${PROVIDER}.clientId`);
    const begin = await beginOAuth({ providerId: PROVIDER, mode: "login", req: req() });
    expect(begin).toEqual({ error: "provider_unavailable" });
  });
});

describe("completeOAuth — signature algorithms", () => {
  it("verifies an RS256 id_token and logs in via session", async () => {
    const { outcome } = await runFlow({ sub: "g-1", email: "rs@test.com", alg: "RS256" });
    // 首登:identity 不存在 → 建 guest + session。
    expect(outcome.kind).toBe("session");
  });

  it("verifies an ES256 id_token and logs in via session", async () => {
    const { outcome } = await runFlow({ sub: "g-2", email: "es@test.com", alg: "ES256" });
    expect(outcome.kind).toBe("session");
  });
});

describe("completeOAuth — id_token claim validation", () => {
  it("rejects a nonce mismatch", async () => {
    const { outcome } = await runFlow({
      sub: "g-3",
      email: "n@test.com",
      claimOverride: { nonce: "wrong-nonce" },
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_failed" });
  });

  it("rejects a bad aud", async () => {
    const { outcome } = await runFlow({
      sub: "g-4",
      email: "a@test.com",
      claimOverride: { aud: "someone-else" },
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_failed" });
  });

  it("rejects a bad iss", async () => {
    const { outcome } = await runFlow({
      sub: "g-5",
      email: "i@test.com",
      claimOverride: { iss: "https://evil.test" },
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_failed" });
  });

  it("rejects an expired id_token", async () => {
    const { outcome } = await runFlow({
      sub: "g-6",
      email: "e@test.com",
      claimOverride: { exp: Math.floor(Date.now() / 1000) - 3600 },
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_failed" });
  });
});

describe("completeOAuth — state one-time use", () => {
  it("rejects a replayed state", async () => {
    const { outcome, state, nonce } = await runFlow({ sub: "g-7", email: "r@test.com" });
    expect(outcome.kind).toBe("session");
    // 同 state 再打一次 → 已被消費 → oauth_state。
    const replay = await runFlow({ sub: "g-7", email: "r@test.com", reuseState: { state, nonce } });
    expect(replay.outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_state" });
  });

  it("rejects an unknown state", async () => {
    const outcome = await completeOAuth({
      providerId: PROVIDER,
      code: "c",
      state: "deadbeef",
      req: req(),
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_state" });
  });

  it("redirects oauth_denied on provider ?error=", async () => {
    const outcome = await completeOAuth({
      providerId: PROVIDER,
      code: null,
      state: null,
      error: "access_denied",
      req: req(),
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_denied" });
  });
});

describe("completeOAuth — registration policy + linking", () => {
  it("creates a guest user with sentinel password + placeholder email when no email claim", async () => {
    const { outcome } = await runFlow({ sub: "no-email-1", name: "LINE User" });
    expect(outcome.kind).toBe("session");
    if (outcome.kind !== "session") return;
    const row = await d1()
      .prepare("SELECT email, role, password_hash FROM users WHERE id = ?1")
      .bind(outcome.userId)
      .first<{ email: string; role: string; password_hash: string }>();
    expect(row?.role).toBe("guest");
    expect(row?.password_hash).toBe("!oauth-only");
    expect(row?.email.endsWith("@placeholder.invalid")).toBe(true);
    expect(row?.email.startsWith(`oauth-${PROVIDER}-`)).toBe(true);
  });

  it("rejects registration when policy is off (not_linked)", async () => {
    settingsStore.set("core.auth.oauthRegistration", "off");
    const { outcome } = await runFlow({ sub: "off-1", email: "off@test.com" });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=not_linked" });
  });

  it("refuses to auto-link when the email collides with an existing user (email_exists)", async () => {
    await seedUser("u-existing", "taken@test.com");
    const { outcome } = await runFlow({ sub: "collide-1", email: "taken@test.com" });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=email_exists" });
    // 沒有新建 identity。
    const ids = await listUserIdentities("u-existing");
    expect(ids).toHaveLength(0);
  });

  it("logs an existing identity straight into its user (session)", async () => {
    // 先建 identity。
    await seedUser("u-known", "known@test.com");
    const first = await runFlow({ sub: "known-1", email: "known@test.com", mode: "link", userId: "u-known" });
    expect(first.outcome.kind).toBe("redirect"); // link → /admin/account?linked=1
    // 之後用 login 模式,identity 已存在 → session 到該 user。
    const second = await runFlow({ sub: "known-1", email: "known@test.com" });
    expect(second.outcome).toEqual({ kind: "session", userId: "u-known", location: "/admin" });
  });

  it("link mode: identity already bound to another user → identity_taken", async () => {
    await seedUser("u-a", "a@test.com");
    await seedUser("u-b", "b@test.com");
    // 先把 identity 綁到 u-a。
    await runFlow({ sub: "shared-sub", email: "a@test.com", mode: "link", userId: "u-a" });
    // u-b 嘗試綁同一個 sub → identity_taken。
    const { outcome } = await runFlow({ sub: "shared-sub", email: "a@test.com", mode: "link", userId: "u-b" });
    expect(outcome).toEqual({ kind: "redirect", location: "/admin/account?error=identity_taken" });
  });

  it("link mode: linking a fresh identity to the current user succeeds", async () => {
    await seedUser("u-fresh", "fresh@test.com");
    const { outcome } = await runFlow({ sub: "fresh-sub", email: "fresh@test.com", mode: "link", userId: "u-fresh" });
    expect(outcome).toEqual({ kind: "redirect", location: "/admin/account?linked=1" });
    const ids = await listUserIdentities("u-fresh");
    expect(ids).toHaveLength(1);
    expect(ids[0].provider).toBe(PROVIDER);
  });
});
