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
  loginErrorLocation,
  refuseUnboundCallback,
  verifyJwt,
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

/** HS256:金鑰是 client secret 本身(LINE 的網頁登入發的 id_token 就是這樣簽,沒有 kid)。 */
async function signHs256(claims: Record<string, unknown>, secret: string, alg = "HS256"): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg, typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)));
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

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 正式站的 Workers fetch 不接受 redirect: "error"(一呼叫就丟 TypeError),假的 fetch 照做 ——
    // 不這樣的話,整套登入在測試裡會過、上線後每一次都 fetch_failed(1.67.0 修掉的就是這個)。
    if (init?.redirect === "error") {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
    if (url.endsWith("/jwks")) return jsonResponse(jwksDoc);
    if (url.endsWith("/token")) return jsonResponse(tokenResponse);
    if (url.endsWith("/userinfo")) return jsonResponse(userinfoDoc);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  // 1.50.0:getSessionUser LEFT JOIN staff_roles(自訂角色)。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT, email_verified_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
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

/** completeOAuth 的 sessionUserId:callback 那個瀏覽器沒有人登入。 */
const notSignedIn = async (): Promise<string | null> => null;

// begin → 解析 state/nonce → 簽 id_token → complete。claimOverride 可覆寫 claims。
async function runFlow(opts: {
  sub: string;
  email?: string;
  name?: string;
  alg?: "RS256" | "ES256";
  /** 給了就用 HS256、拿這個字串當金鑰簽(不看 alg)。 */
  hsSecret?: string;
  mode?: "login" | "link";
  userId?: string;
  claimOverride?: Record<string, unknown>;
  reuseState?: { state: string; nonce: string };
  back?: string;
  next?: string;
  /** callback 那個瀏覽器登入的是誰(null = 沒登入);沒給就是 userId。 */
  signedInAs?: string | null;
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
      next: opts.next ?? "/admin",
      back: opts.back,
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
  tokenResponse = { id_token: opts.hsSecret !== undefined ? await signHs256(claims, opts.hsSecret) : await signJwt(claims, alg), access_token: "at-1" };

  const outcome = await completeOAuth({
    providerId: PROVIDER,
    code: "auth-code",
    state,
    req: req(),
    // 沒特別說,就是開始的那個人還登入著(連結模式才會問)。
    sessionUserId: async () => (opts.signedInAs === undefined ? (opts.userId ?? null) : opts.signedInAs),
  });
  return { outcome, state, nonce };
}

async function seedUser(id: string, email: string, role = "editor", emailVerified = false): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO users (id, email, password_hash, name, role, created_at, email_verified_at) VALUES (?1, ?2, 'x', ?3, ?4, ?5, ?6)",
    )
    .bind(id, email.toLowerCase(), "Name", role, Date.now(), emailVerified ? Date.now() : null)
    .run();
}

const accountEmail = async (userId: string): Promise<string | undefined> =>
  (await d1().prepare("SELECT email FROM users WHERE id = ?1").bind(userId).first<{ email: string }>())?.email;

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

  // 1.76.0:/start 要把 state 綁在瀏覽器上(cookie),所以引擎把 state 一起交出來。
  it("hands the state back alongside the URL that carries it", async () => {
    const begin = await beginOAuth({ providerId: PROVIDER, mode: "login", req: req() });
    if (!("location" in begin)) throw new Error("beginOAuth failed");
    expect(begin.state).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(begin.location).searchParams.get("state")).toBe(begin.state);
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

  // 1.76.0:LINE 的網頁登入發 HS256 的 id_token(金鑰是 channel secret),雖然它的 discovery 只寫 ES256。
  it("verifies an HS256 id_token signed with the client secret", async () => {
    const { outcome } = await runFlow({ sub: "g-3", email: "hs@test.com", hsSecret: "secret-xyz" });
    expect(outcome.kind).toBe("session");
  });

  it("rejects an HS256 id_token signed with another secret, and logs which step failed without any secret", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { outcome, state } = await runFlow({ sub: "g-4", email: "hs2@test.com", hsSecret: "not-the-secret" });
      expect(outcome).toMatchObject({ kind: "redirect", location: expect.stringContaining("oauth_failed") });
      expect(logged.mock.calls).toEqual([["[oidc] sign-in failed", PROVIDER, "idtoken_bad_signature"]]);
      const line = JSON.stringify(logged.mock.calls);
      for (const secret of ["secret-xyz", "not-the-secret", "auth-code", state, "hs2@test.com"]) expect(line).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
  });

  // 簽章對了之後,iss / aud / exp / nonce 照樣要過(跟 RS256、ES256 同一段檢查)。
  it.each([
    ["nonce", { nonce: "someone-elses" }, "idtoken_bad_nonce"],
    ["aud", { aud: "another-client" }, "idtoken_bad_aud"],
    ["iss", { iss: "https://evil.test" }, "idtoken_bad_iss"],
    ["exp", { exp: Math.floor(Date.now() / 1000) - 3600 }, "idtoken_expired"],
  ])("still checks %s on an HS256 id_token", async (_claim, claimOverride, reason) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { outcome } = await runFlow({ sub: "g-5", email: "hs3@test.com", hsSecret: "secret-xyz", claimOverride });
      expect(outcome).toMatchObject({ kind: "redirect", location: expect.stringContaining("oauth_failed") });
      expect(logged.mock.calls).toEqual([["[oidc] sign-in failed", PROVIDER, reason]]);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("verifyJwt — HS256 only with a secret from the caller", () => {
  const claims = () => ({ iss: ISSUER, aud: CLIENT_ID, sub: "u-1", exp: Math.floor(Date.now() / 1000) + 600 });
  const expected = { issuer: ISSUER, audience: CLIENT_ID };

  it("accepts it when the caller passes the secret", async () => {
    const token = await signHs256(claims(), "s3cret-long-enough");
    const { claims: out } = await verifyJwt(token, [], { ...expected, clientSecret: "s3cret-long-enough" });
    expect(out.sub).toBe("u-1");
  });

  it("refuses HS256 when no secret was passed (a caller that only trusts published keys)", async () => {
    const token = await signHs256(claims(), "s3cret-long-enough");
    await expect(verifyJwt(token, [], expected)).rejects.toThrow("unsupported_alg");
    await expect(verifyJwt(token, [], { ...expected, clientSecret: "" })).rejects.toThrow("unsupported_alg");
  });

  it("never uses a published key as the HS256 secret", async () => {
    // 演算法混淆:對方公開的金鑰清單裡混進一把對稱金鑰(kty: oct),再用它簽一張 HS256。
    // 沒有傳 clientSecret 就不收 HS256;傳了也只用那個字串驗,清單裡的金鑰不看。
    const planted = "planted-symmetric-key";
    const oct = { kty: "oct", k: b64urlStr(planted), alg: "HS256" };
    const jwks = [...jwksDoc.keys, oct] as never;
    const token = await signHs256(claims(), planted);
    await expect(verifyJwt(token, jwks, expected)).rejects.toThrow("unsupported_alg");
    await expect(verifyJwt(token, jwks, { ...expected, clientSecret: "s3cret-long-enough" })).rejects.toThrow("idtoken_bad_signature");
  });

  it("treats a signature that is not base64url as a malformed token, and inherited names as unknown algorithms", async () => {
    const [header, payload] = (await signHs256(claims(), "s3cret-long-enough")).split(".");
    await expect(verifyJwt(`${header}.${payload}.***`, [], { ...expected, clientSecret: "s3cret-long-enough" })).rejects.toThrow("idtoken_malformed");
    const inherited = `${b64urlStr(JSON.stringify({ alg: "constructor" }))}.${payload}.${b64urlStr("x")}`;
    await expect(verifyJwt(inherited, jwksDoc.keys as never, expected)).rejects.toThrow("unsupported_alg");
  });

  it("still refuses alg none and other names", async () => {
    const none = `${b64urlStr(JSON.stringify({ alg: "none" }))}.${b64urlStr(JSON.stringify(claims()))}.`;
    await expect(verifyJwt(none, [], { ...expected, clientSecret: "s3cret-long-enough" })).rejects.toThrow("unsupported_alg");
    const hs512 = await signHs256(claims(), "s3cret-long-enough", "HS512");
    await expect(verifyJwt(hs512, [], { ...expected, clientSecret: "s3cret-long-enough" })).rejects.toThrow("unsupported_alg");
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
      sessionUserId: notSignedIn,
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
      sessionUserId: notSignedIn,
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=oauth_denied" });
  });
});

// 1.76.0:callback 到了別的瀏覽器(route 發現綁定的 cookie 沒帶或對不上)。引擎只決定把人送去哪;
// state 不取用 —— 不然任何拿得到 callback 網址的人都能把正在登入的人那一次作廢。
describe("refuseUnboundCallback — a callback in a browser that did not start the flow", () => {
  async function started(opts: { mode?: "login" | "link"; userId?: string; back?: string } = {}) {
    const begin = await beginOAuth({ providerId: PROVIDER, mode: opts.mode ?? "login", userId: opts.userId, next: "/admin", back: opts.back, req: req() });
    if ("error" in begin) throw new Error(`beginOAuth failed: ${begin.error}`);
    const params = new URL(begin.location).searchParams;
    return { state: params.get("state")!, nonce: params.get("nonce")! };
  }
  const stateRows = async (state: string) =>
    (await d1().prepare("SELECT count(*) AS c FROM oauth_states WHERE id = ?1").bind(state).first<{ c: number }>())?.c;

  it("sends a sign-in back to the page it started from with its own code, and the state still works", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const flow = await started({ back: "/member/sign-in?next=%2Fshop%2Forders" });
      const outcome = await refuseUnboundCallback({ providerId: PROVIDER, state: flow.state });
      expect(outcome).toEqual({ kind: "redirect", location: "/member/sign-in?next=%2Fshop%2Forders&login_error=oauth_browser" });
      expect(await stateRows(flow.state)).toBe(1);
      // 記的那一行只有我們自己的代號,沒有 state。
      expect(logged.mock.calls).toEqual([["[oidc] sign-in refused", PROVIDER, "browser_mismatch"]]);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(flow.state);

      const done = await runFlow({ sub: "kept-1", email: "kept@test.com", reuseState: flow });
      expect(done.outcome.kind).toBe("session");
    } finally {
      logged.mockRestore();
    }
  });

  it("falls back to the admin sign-in page when the flow had no back page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const flow = await started();
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: flow.state })).toEqual({
        kind: "redirect",
        location: "/login?error=oauth_browser",
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("link mode goes to the account page, links nothing and keeps the state", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedUser("u-linking", "linking@test.com");
      const flow = await started({ mode: "link", userId: "u-linking" });
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: flow.state })).toEqual({
        kind: "redirect",
        location: "/admin/account?error=oauth_browser",
      });
      expect(await listUserIdentities("u-linking")).toHaveLength(0);
      expect(await stateRows(flow.state)).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("a provider error keeps the code it always had, and the state is still not consumed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedUser("u-linking2", "linking2@test.com");
      const signIn = await started({ back: "/shop/checkout" });
      const link = await started({ mode: "link", userId: "u-linking2" });
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: signIn.state, error: "access_denied" })).toEqual({
        kind: "redirect",
        location: "/shop/checkout?login_error=oauth_denied",
      });
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: link.state, error: "access_denied" })).toEqual({
        kind: "redirect",
        location: "/admin/account?error=oauth_failed",
      });
      expect(await stateRows(signIn.state)).toBe(1);
      expect(await stateRows(link.state)).toBe(1);
      // 取消不是「換了瀏覽器」:不記那一行。
      expect(logged.mock.calls).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it("a state that is gone, expired, another provider's or not a state at all is the ordinary timeout", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const timeout = { kind: "redirect", location: "/login?error=oauth_state" };
      const expired = await started({ back: "/member/sign-in" });
      await d1().prepare("UPDATE oauth_states SET expires_at = ?1 WHERE id = ?2").bind(Date.now() - 1, expired.state).run();
      const live = await started({ back: "/member/sign-in" });

      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: "deadbeef".repeat(8) })).toEqual(timeout);
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: expired.state })).toEqual(timeout);
      expect(await refuseUnboundCallback({ providerId: "another-login", state: live.state })).toEqual(timeout);
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: "' OR 1=1 --" })).toEqual(timeout);
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: null })).toEqual(timeout);
      expect(await refuseUnboundCallback({ providerId: PROVIDER, state: null, error: "access_denied" })).toEqual({
        kind: "redirect",
        location: "/login?error=oauth_denied",
      });
      expect(await stateRows(live.state)).toBe(1);
      expect(logged.mock.calls).toEqual([]);
    } finally {
      logged.mockRestore();
    }
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

  it("gives two people their own accounts when the hashes of their ids start with the same eight characters", async () => {
    // 代用地址裡那一段是 SHA-256(sub) 的開頭。以前只取 8 個字:這兩個 sub 的開頭 8 個字一樣(7d8d0ed8),
    // 第二個人建帳號時撞上 email 的 UNIQUE,登入就失敗了。現在取 16 個字。
    const TWINS = ["line-user-47225", "line-user-70444"];
    const head = async (sub: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    expect(await head(TWINS[0])).toBe("7d8d0ed8");
    expect(await head(TWINS[1])).toBe("7d8d0ed8");

    const first = await runFlow({ sub: TWINS[0], name: "第一位" });
    const second = await runFlow({ sub: TWINS[1], name: "第二位" });
    expect(first.outcome.kind).toBe("session");
    expect(second.outcome.kind).toBe("session");
    if (first.outcome.kind !== "session" || second.outcome.kind !== "session") return;
    expect(second.outcome.userId).not.toBe(first.outcome.userId);
    const emails = [await accountEmail(first.outcome.userId), await accountEmail(second.outcome.userId)];
    expect(emails[0]).not.toBe(emails[1]);
    for (const email of emails) expect(email).toMatch(new RegExp(`^oauth-${PROVIDER}-7d8d0ed8[0-9a-f]{8}@placeholder\\.invalid$`));
    // 各自再登入一次,回到各自的帳號。
    expect((await runFlow({ sub: TWINS[1] })).outcome).toMatchObject({ kind: "session", userId: second.outcome.userId });
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
    expect(second.outcome).toEqual({ kind: "session", userId: "u-known", location: "/admin", emailVerified: true });
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

  // 1.76.0:完成連結的瀏覽器要登入著開始連結的那個帳號。不然知道 state 的人在自己的瀏覽器、用自己在
  // 對方那邊的身分走完,他的身分就掛到別人的帳號上(之後能用它登入那個帳號)。
  it.each([
    ["nobody is signed in", null],
    ["another account is signed in", "u-someone-else"],
  ])("link mode: nothing is linked when %s in the browser that comes back", async (_name, signedInAs) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedUser("u-target", "target@test.com");
      await seedUser("u-someone-else", "else@test.com");
      const tokenCalls = () => vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/token")).length;
      const before = tokenCalls();
      const { outcome } = await runFlow({ sub: "intruder-sub", email: "intruder@test.com", mode: "link", userId: "u-target", signedInAs });
      expect(outcome).toEqual({ kind: "redirect", location: "/admin/account?error=oauth_browser" });
      expect(await listUserIdentities("u-target")).toHaveLength(0);
      expect(await listUserIdentities("u-someone-else")).toHaveLength(0);
      // 沒去換 token;記的那一行只有代號。
      expect(tokenCalls()).toBe(before);
      expect(logged.mock.calls).toEqual([["[oidc] sign-in refused", PROVIDER, "link_other_account"]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("sign-in mode never asks who is signed in", async () => {
    const asked = vi.fn(async () => "u-whoever");
    const begin = await beginOAuth({ providerId: PROVIDER, mode: "login", next: "/admin", req: req() });
    if ("error" in begin) throw new Error(begin.error);
    const nonce = new URL(begin.location).searchParams.get("nonce");
    const now = Math.floor(Date.now() / 1000);
    tokenResponse = {
      id_token: await signJwt({ iss: ISSUER, aud: CLIENT_ID, exp: now + 3600, iat: now, nonce, sub: "plain-sign-in", email: "plain@test.com", email_verified: true }, "RS256"),
      access_token: "at-1",
    };
    const outcome = await completeOAuth({ providerId: PROVIDER, code: "auth-code", state: begin.state, req: req(), sessionUserId: asked });
    expect(outcome.kind).toBe("session");
    expect(asked).not.toHaveBeenCalled();
  });
});

// 1.54.0:前台會員也用第三方登入 —— Email 已驗證的一般會員自動綁上;失敗回到 back 那一頁。
describe("completeOAuth — members and back (1.54.0)", () => {
  it("links a verified email to an existing plain member and signs in", async () => {
    await seedUser("u-member", "member@test.com", "guest", true);
    const { outcome } = await runFlow({ sub: "member-1", email: "member@test.com", next: "/shop/checkout" });
    expect(outcome).toEqual({ kind: "session", userId: "u-member", location: "/shop/checkout", emailVerified: true });
    const ids = await listUserIdentities("u-member");
    expect(ids).toHaveLength(1);
  });

  it("does not link a member whose own email was never proven (pre-hijacking)", async () => {
    // 寄不出信時直接註冊、或管理員手動建立:任何人都能拿別人的 Email 建這種帳號。
    await seedUser("u-unproven", "unproven@test.com", "guest", false);
    const { outcome } = await runFlow({ sub: "unproven-1", email: "unproven@test.com" });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=email_exists" });
    expect(await listUserIdentities("u-unproven")).toHaveLength(0);
  });

  it("marks a new account's email verified only when the provider verified it", async () => {
    const verified = await runFlow({ sub: "fresh-verified", email: "fresh-v@test.com" });
    const unverified = await runFlow({
      sub: "fresh-unverified",
      email: "fresh-u@test.com",
      claimOverride: { email_verified: undefined },
    });
    const at = async (email: string) =>
      (await d1().prepare("SELECT email_verified_at FROM users WHERE email = ?1").bind(email).first<{ email_verified_at: number | null }>())?.email_verified_at;
    expect(verified.outcome.kind).toBe("session");
    expect(unverified.outcome.kind).toBe("session");
    expect(await at("fresh-v@test.com")).toEqual(expect.any(Number));
    // 對方沒說驗證過的 email 不會變成帳號的 Email(見下面「沒有證明過的 email」那一組):沒有這個地址的帳號。
    expect(await at("fresh-u@test.com")).toBeUndefined();
    // 1.56.0:auth:signed-in 的 emailVerified 跟著同一個判斷走。
    expect(verified.outcome).toMatchObject({ emailVerified: true });
    expect(unverified.outcome).toMatchObject({ emailVerified: false });
  });

  it("emailVerified is false when the provider's email is not the account's email (1.56.0)", async () => {
    await seedUser("u-moved", "old@test.com");
    await runFlow({ sub: "moved-1", email: "old@test.com", mode: "link", userId: "u-moved" });
    const { outcome } = await runFlow({ sub: "moved-1", email: "new@test.com" });
    expect(outcome).toEqual({ kind: "session", userId: "u-moved", location: "/admin", emailVerified: false });
  });

  it("does not link when the provider does not say the email is verified", async () => {
    await seedUser("u-member2", "member2@test.com", "guest", true);
    const { outcome } = await runFlow({
      sub: "member-2",
      email: "member2@test.com",
      claimOverride: { email_verified: undefined },
    });
    // 那個 email 當作沒給:不綁到既有的帳號上,也不說「這個 Email 已經有帳號」(不讓人拿它探別人有沒有註冊)。
    // 這個人拿到一個沒有 Email 的新帳號。
    expect(outcome).toMatchObject({ kind: "session", emailVerified: false });
    if (outcome.kind !== "session") return;
    expect(outcome.userId).not.toBe("u-member2");
    expect(await listUserIdentities("u-member2")).toHaveLength(0);
    expect(await accountEmail(outcome.userId)).toMatch(/@placeholder\.invalid$/);
  });

  it("does not link a guest account that carries a custom staff role", async () => {
    await seedUser("u-staff", "staff@test.com", "guest", true);
    await d1().prepare("UPDATE users SET staff_role_id = 'r-1' WHERE id = 'u-staff'").run();
    const { outcome } = await runFlow({ sub: "staff-1", email: "staff@test.com" });
    expect(outcome).toEqual({ kind: "redirect", location: "/login?error=email_exists" });
  });

  it("sends a failed sign-in back to the page it started from", async () => {
    await seedUser("u-editor", "editor@test.com");
    const { outcome } = await runFlow({
      sub: "editor-1",
      email: "editor@test.com",
      back: "/member/sign-in?next=%2Fshop%2Forders",
    });
    expect(outcome).toEqual({
      kind: "redirect",
      location: "/member/sign-in?next=%2Fshop%2Forders&login_error=email_exists",
    });
  });

  it("sends a provider ?error= back to the page it started from", async () => {
    const begin = await beginOAuth({
      providerId: PROVIDER,
      mode: "login",
      next: "/shop/checkout",
      back: "/shop/checkout",
      req: req(),
    });
    if ("error" in begin) throw new Error(begin.error);
    const state = new URL(begin.location).searchParams.get("state");
    const outcome = await completeOAuth({
      providerId: PROVIDER,
      code: null,
      state,
      error: "access_denied",
      req: req(),
      sessionUserId: notSignedIn,
    });
    expect(outcome).toEqual({ kind: "redirect", location: "/shop/checkout?login_error=oauth_denied" });
  });
});

// 對方沒有明講「已驗證」(email_verified === true)的 email 不是這個人的 Email:LINE 的 ID token 有 email
// 但沒有 email_verified,文件也沒說那個地址驗證過。拿它當帳號的 Email,等於讓人用別人的地址開帳號 ——
// 信箱的主人之後用驗證碼登入,會進到一個對方的 LINE 也進得來的帳號(預先劫持)。
describe("completeOAuth — an email the provider does not vouch for", () => {
  it.each([
    ["no email_verified claim", { email_verified: undefined }],
    ["email_verified: false", { email_verified: false }],
    ["email_verified as a string", { email_verified: "true" }],
  ])("never becomes the account's email (%s)", async (_name, claimOverride) => {
    const { outcome } = await runFlow({ sub: "unproven-1", email: "someone@test.com", name: "LINE User", claimOverride });
    expect(outcome).toMatchObject({ kind: "session", emailVerified: false });
    if (outcome.kind !== "session") return;
    const row = await d1()
      .prepare("SELECT email, email_verified_at, role, password_hash FROM users WHERE id = ?1")
      .bind(outcome.userId)
      .first<{ email: string; email_verified_at: number | null; role: string; password_hash: string }>();
    // 和「對方沒給 email」一樣:寄不到的代用地址、沒有驗證時間。
    expect(row).toMatchObject({ email_verified_at: null, role: "guest", password_hash: "!oauth-only" });
    expect(row?.email).toMatch(new RegExp(`^oauth-${PROVIDER}-[0-9a-f]{16}@placeholder\\.invalid$`));
    expect(await d1().prepare("SELECT id FROM users WHERE email = 'someone@test.com'").first()).toBeNull();
  });

  it("pre-hijacking: the address's real owner ends up in an account the other identity cannot enter", async () => {
    // 有人把別人的地址掛在自己的身分上先來登入。
    const attacker = await runFlow({ sub: "attacker-sub", email: "victim@test.com", claimOverride: { email_verified: undefined } });
    expect(attacker.outcome.kind).toBe("session");
    if (attacker.outcome.kind !== "session") return;
    expect(await accountEmail(attacker.outcome.userId)).not.toBe("victim@test.com");

    // 信箱的主人之後證明了信箱、有了自己的帳號(會員插件的驗證碼流程;這裡直接放一列),再用自己的身分登入。
    await seedUser("u-victim", "victim@test.com", "guest", true);
    const victim = await runFlow({ sub: "victim-sub", email: "victim@test.com" });
    expect(victim.outcome).toMatchObject({ kind: "session", userId: "u-victim" });
    expect((await listUserIdentities("u-victim")).map((identity) => identity.id)).toHaveLength(1);

    // 先來的那個身分再登入,進的還是自己那個沒有 Email 的帳號。
    const again = await runFlow({ sub: "attacker-sub", email: "victim@test.com", claimOverride: { email_verified: undefined } });
    expect(again.outcome).toMatchObject({ kind: "session", userId: attacker.outcome.userId, emailVerified: false });
    expect(attacker.outcome.userId).not.toBe("u-victim");
  });

  it("a verified email still becomes the account's email", async () => {
    const { outcome } = await runFlow({ sub: "proven-1", email: "Proven@Test.com" });
    expect(outcome).toMatchObject({ kind: "session", emailVerified: true });
    if (outcome.kind !== "session") return;
    expect(await accountEmail(outcome.userId)).toBe("proven@test.com");
  });

  it("link mode is unchanged: the identity is attached, the account's email stays, the label is what the provider calls it", async () => {
    await seedUser("u-linker", "linker@test.com", "guest", true);
    const { outcome } = await runFlow({ sub: "line-1", email: "other@test.com", mode: "link", userId: "u-linker", claimOverride: { email_verified: undefined } });
    expect(outcome).toEqual({ kind: "redirect", location: "/admin/account?linked=1" });
    expect(await accountEmail("u-linker")).toBe("linker@test.com");
    expect(await listUserIdentities("u-linker")).toMatchObject([{ provider: PROVIDER, display: "other@test.com" }]);
  });
});

describe("loginErrorLocation", () => {
  it("falls back to the admin sign-in page without a usable back path", () => {
    expect(loginErrorLocation("oauth_failed")).toBe("/login?error=oauth_failed");
    expect(loginErrorLocation("oauth_failed", "//evil.test/x")).toBe("/login?error=oauth_failed");
    expect(loginErrorLocation("oauth_failed", "https://evil.test/")).toBe("/login?error=oauth_failed");
    expect(loginErrorLocation("oauth_failed", "/\\evil.test")).toBe("/login?error=oauth_failed");
  });

  it("keeps the back page's query and hash", () => {
    expect(loginErrorLocation("oauth_denied", "/member/sign-in?a=1#top")).toBe(
      "/member/sign-in?a=1&login_error=oauth_denied#top",
    );
  });

  // "/..//evil.test" 過得了「單一斜線起頭」的檢查,但網址化簡之後是 "//evil.test":瀏覽器會當成別的網站。
  it("does not turn a path that collapses into another site's address into a redirect there", () => {
    for (const back of ["/..//evil.test", "/.//evil.test", "/a/..//evil.test", "/%2e%2e//evil.test", "/%2E%2E//evil.test/x?y=1"]) {
      const location = loginErrorLocation("oauth_browser", back);
      expect(location).toBe("/login?error=oauth_browser");
      expect(new URL(location, "https://cms.test/api/auth/oauth/x/callback").origin).toBe("https://cms.test");
    }
    // 中間有兩條斜線的站內路徑照舊。
    expect(loginErrorLocation("oauth_denied", "/a//b")).toBe("/a//b?login_error=oauth_denied");
  });
});
