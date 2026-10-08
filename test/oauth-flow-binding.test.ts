import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.76.0:OAuth 的 state 綁在開始登入的那個瀏覽器上(login CSRF)。
//
// 這一檔走**真的**兩個 route(/api/auth/oauth/[provider]/start、/callback)和真的引擎、真的 D1 列;
// 換掉的只有對方的伺服器(discovery / token / jwks,假的 fetch)、設定、插件 runtime,以及 cookie ——
// next/headers 的 cookies() 接到一個「瀏覽器」(一個 Map)。換一個 Map 就是換一個瀏覽器。
// 引擎本身的規則(簽章、claims、帳號對應)在 test/oidc.test.ts。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const settingsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/settings", () => ({
  getSetting: async <T>(key: string, fallback?: T): Promise<T> =>
    (settingsStore.has(key) ? (settingsStore.get(key) as unknown as T) : (fallback as T)),
  extSetting: (extId: string, key: string): string => `ext.${extId}.${key}`,
}));

interface Cookie {
  value: string;
  options: Record<string, unknown>;
}
type Jar = Map<string, Cookie>;
interface CookieWrite extends Cookie {
  name: string;
}

// 「瀏覽器」:jar 是它手上的 cookie,writes 是這一輪伺服器叫它設的(含刪除)。
// 刪除照瀏覽器的規矩:Max-Age=0 而且 Path 跟當初設的一樣才刪得掉。
const browser = vi.hoisted(() => ({
  jar: new Map() as Jar,
  writes: [] as CookieWrite[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const found = browser.jar.get(name);
      return found ? { name, value: found.value } : undefined;
    },
    getAll: () => [...browser.jar].map(([name, cookie]) => ({ name, value: cookie.value })),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      browser.writes.push({ name, value, options });
      if (options.maxAge !== 0) {
        browser.jar.set(name, { value, options });
        return;
      }
      const held = browser.jar.get(name);
      if (held && (held.options.path ?? "/") === (options.path ?? "/")) browser.jar.delete(name);
    },
    delete: (name: string) => void browser.jar.delete(name),
  }),
}));

const hookState = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  hooks.register("test", "auth:signed-in", (event: unknown) => void hookState.events.push(event));
  const rt = { enabled: [], all: [], hooks, byId: () => undefined, isCompatible: () => true, unavailableById: new Map() };
  return { getExtRuntime: async () => rt };
});

import { GET as startRoute } from "../src/app/api/auth/oauth/[provider]/start/route";
import { GET as callbackRoute } from "../src/app/api/auth/oauth/[provider]/callback/route";
import { POST as firebaseRoute } from "../src/app/api/auth/firebase/[provider]/route";
import { createSession } from "../src/lib/auth";
import { __clearOidcCaches, listUserIdentities } from "../src/lib/oidc";
import {
  MAX_OAUTH_FLOWS,
  OAUTH_FLOW_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  bindOAuthFlow,
  oauthFlowCookieName,
  oauthStateHash,
  takeOAuthFlow,
} from "../src/lib/oauth-flow-cookie";

const d1 = () => (env as { DB: D1Database }).DB;

const PROVIDER = "example-login";
const ISSUER = "https://oidc.test";
const CLIENT_ID = "client-abc";
const ORIGIN = "https://cms.test";
const ctx = { params: Promise.resolve({ provider: PROVIDER }) };

const MANIFEST = {
  kind: "declarative",
  id: PROVIDER,
  name: "Example Login",
  version: "1.0.0",
  coreApi: "^1.16.0",
  loginProvider: { issuer: ISSUER, button: { label: "Continue with Example" } },
  settings: [
    { key: "clientId", label: "Client ID", type: "text", default: "" },
    { key: "clientSecret", label: "Client Secret", type: "text", secret: true, default: "" },
  ],
};

// ---- 對方的伺服器(假的)----

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));
async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

let keys: CryptoKeyPair;
let jwksDoc: { keys: JsonWebKey[] };
let tokenResponse: unknown = {};
const fetched: string[] = [];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", kid: "rsa-1", typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keys.privateKey, data));
  return `${header}.${payload}.${b64url(sig)}`;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  jwksDoc = { keys: [{ ...jwk, kid: "rsa-1", alg: "RS256", use: "sig" } as JsonWebKey] };

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    fetched.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url.endsWith("/jwks")) return jsonResponse(jwksDoc);
    if (url.endsWith("/token")) return jsonResponse(tokenResponse);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const tables = [
    "CREATE TABLE IF NOT EXISTS staff_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT, email_verified_at INTEGER);",
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, display TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);",
    "CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  ];
  for (const sql of tables) await d1().exec(sql);
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
  fetched.length = 0;
  hookState.events.length = 0;
  browser.jar = new Map();
  browser.writes = [];
  for (const table of ["users", "sessions", "user_identities", "oauth_states", "login_attempts", "declarative_extensions"]) {
    await d1().exec(`DELETE FROM ${table};`);
  }
  await d1()
    .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, installed_at, updated_at) VALUES (?1, ?2, '1.0.0', 1, ?3, ?3)")
    .bind(PROVIDER, JSON.stringify(MANIFEST), Date.now())
    .run();
});

// ---- 一次登入的三個動作:按下登入、在對方那邊同意、對方把人送回來 ----

/** 之後的請求都從這個瀏覽器發出;writes 從頭記。 */
function openIn(jar: Jar): void {
  browser.jar = jar;
  browser.writes = [];
}

interface Started {
  status: number;
  /** 被送去哪(對方的授權頁,或失敗時站內的頁面)。 */
  location: URL;
  state: string;
  nonce: string;
}

/** headers:瀏覽器跟著這個請求送的(例如 Sec-Fetch-Site:這個請求是從哪裡來的)。 */
async function start(query = "next=%2Fadmin", headers: Record<string, string> = {}): Promise<Started> {
  const res = await startRoute(new Request(`${ORIGIN}/api/auth/oauth/${PROVIDER}/start?${query}`, { headers }), ctx);
  const location = new URL(res.headers.get("location") ?? `${ORIGIN}/no-location`);
  return {
    status: res.status,
    location,
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
  };
}

/** 對方那邊有人同意了:下一次換 token 拿到的是這個人的 id_token。 */
async function approve(flow: Started, person: { sub: string; email?: string }): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  tokenResponse = {
    access_token: "at-1",
    id_token: await signIdToken({
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 3600,
      nonce: flow.nonce,
      sub: person.sub,
      ...(person.email ? { email: person.email, email_verified: true } : {}),
    }),
  };
}

/** 對方把瀏覽器送回 callback;回傳站內的去處(路徑 + 查詢)。 */
async function callback(params: Record<string, string>): Promise<string> {
  const url = new URL(`${ORIGIN}/api/auth/oauth/${PROVIDER}/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await callbackRoute(new Request(url), ctx);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin).toBe(ORIGIN);
  return `${location.pathname}${location.search}`;
}

const flowCookies = (jar: Jar): string[] => [...jar.keys()].filter((name) => name.startsWith("oauth_flow_"));
const cookieNameOf = async (state: string): Promise<string> => `oauth_flow_${(await sha256b64url(state)).slice(0, 8)}`;
const stateRows = async (state: string): Promise<number> =>
  (await d1().prepare("SELECT count(*) AS c FROM oauth_states WHERE id = ?1").bind(state).first<{ c: number }>())?.c ?? 0;
const tokenCalls = (): number => fetched.filter((url) => url.endsWith("/token")).length;

async function seedUser(id: string, role: "admin" | "editor" | "guest" = "editor"): Promise<void> {
  await d1()
    .prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?1, ?2, 'x', ?1, ?3, ?4)")
    .bind(id, `${id}@test.com`, role, Date.now())
    .run();
}
/** 這個瀏覽器登入了這個人(真的 session 列)。 */
async function signedIn(jar: Jar, userId: string): Promise<void> {
  jar.set("session", { value: await createSession(userId), options: { path: "/" } });
}
const userOfSession = async (jar: Jar): Promise<string | undefined> => {
  const raw = jar.get("session")?.value;
  if (!raw) return undefined;
  const id = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return (await d1().prepare("SELECT user_id FROM sessions WHERE id = ?1").bind(id).first<{ user_id: string }>())?.user_id;
};
const userOfIdentity = async (sub: string): Promise<string | undefined> =>
  (await d1().prepare("SELECT user_id FROM user_identities WHERE provider_user_id = ?1").bind(sub).first<{ user_id: string }>())?.user_id;

/** 伺服器記的那一行;不讓它印到測試輸出裡。 */
function quietLog() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("/start:記下是哪個瀏覽器開始的", () => {
  it("設一個只給 OAuth 路徑的 cookie:HttpOnly、Secure、SameSite=Lax,活得跟 state 一樣久,放的是 state 的雜湊", async () => {
    const before = Date.now();
    const flow = await start();
    expect(flow.status).toBe(302);
    expect(`${flow.location.origin}${flow.location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(flow.state).toMatch(/^[0-9a-f]{64}$/);

    expect(browser.writes).toHaveLength(1);
    const [cookie] = browser.writes;
    const hash = await sha256b64url(flow.state);
    expect(cookie.name).toBe(`oauth_flow_${hash.slice(0, 8)}`);
    expect(cookie.options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/oauth", maxAge: 600 });
    // 放的是雜湊,不是 state 本身:cookie 被看到也湊不出 callback 的網址。
    expect(cookie.value.split(".")[0]).toBe(hash);
    expect(cookie.value).not.toContain(flow.state);

    // Max-Age 就是 state 那一列的壽命;Path 蓋得到兩個端點。
    const row = await d1().prepare("SELECT expires_at FROM oauth_states WHERE id = ?1").bind(flow.state).first<{ expires_at: number }>();
    expect(OAUTH_STATE_TTL_MS).toBe(600_000);
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + OAUTH_STATE_TTL_MS);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + OAUTH_STATE_TTL_MS);
    expect(OAUTH_FLOW_COOKIE_PATH).toBe("/api/auth/oauth");
    for (const endpoint of ["start", "callback"]) {
      expect(`/api/auth/oauth/${PROVIDER}/${endpoint}`.startsWith(`${OAUTH_FLOW_COOKIE_PATH}/`)).toBe(true);
    }
  });

  it("登入方式不能用:回登入頁,不設 cookie", async () => {
    settingsStore.delete(`ext.${PROVIDER}.clientId`);
    const flow = await start();
    expect(`${flow.location.pathname}${flow.location.search}`).toBe("/login?error=provider_unavailable");
    expect(browser.writes).toEqual([]);
  });

  // back 是網址上帶來的。"/..//evil.test" 化簡之後是 "//evil.test",不能把人送到別的網站去。
  it("back 化簡之後是別的網站:失敗時回登入頁,不出站", async () => {
    settingsStore.delete(`ext.${PROVIDER}.clientId`);
    for (const back of ["/..//evil.test", "/%2e%2e//evil.test"]) {
      const flow = await start(`back=${encodeURIComponent(back)}`);
      expect(flow.location.origin).toBe(ORIGIN);
      expect(`${flow.location.pathname}${flow.location.search}`).toBe("/login?error=provider_unavailable");
    }
  });

  it("同一個瀏覽器開兩個分頁各按一次登入:兩次都完成得了", async () => {
    const first = await start();
    const second = await start();
    expect(flowCookies(browser.jar)).toHaveLength(2);

    await approve(second, { sub: "tab-2", email: "tab2@test.com" });
    expect(await callback({ code: "c", state: second.state })).toBe("/admin");
    await approve(first, { sub: "tab-1", email: "tab1@test.com" });
    expect(await callback({ code: "c", state: first.state })).toBe("/admin");
    expect(flowCookies(browser.jar)).toEqual([]);
  });

  it("按了很多次沒走完:最多留十個,最新的那一次照樣完成", async () => {
    let last = await start();
    for (let i = 0; i < MAX_OAUTH_FLOWS + 2; i++) last = await start();
    expect(MAX_OAUTH_FLOWS).toBe(10);
    expect(flowCookies(browser.jar)).toHaveLength(MAX_OAUTH_FLOWS);
    expect(flowCookies(browser.jar)).toContain(await cookieNameOf(last.state));

    await approve(last, { sub: "persistent", email: "persistent@test.com" });
    expect(await callback({ code: "c", state: last.state })).toBe("/admin");
  });
});

// 連結是「把一個身分掛到我登入著的帳號上」,只該由帳號的主人在站內按下去。/start 是 GET,別的網站放一個連結或一次
// 轉址,就能在登入著的人的瀏覽器裡替他開始一次(cookie 也會照設)。瀏覽器會說請求從哪裡來(Sec-Fetch-Site)。
describe("/start:別的網站替登入著的人開始連結", () => {
  const LINK = "mode=link&next=%2Fadmin%2Faccount";
  const states = async (): Promise<number> => (await d1().prepare("SELECT count(*) AS c FROM oauth_states").first<{ c: number }>())?.c ?? 0;
  const whereTo = (flow: Started): string => `${flow.location.origin}${flow.location.pathname}${flow.location.search}`;

  it("瀏覽器說是別的網站來的:不開始,回帳號頁說要在這裡按;沒有 state、沒有 cookie、沒有問對方的伺服器", async () => {
    await seedUser("u-victim", "admin");
    const victim: Jar = new Map();
    await signedIn(victim, "u-victim");
    openIn(victim);
    const forced = await start(LINK, { "Sec-Fetch-Site": "cross-site" });
    expect(forced.status).toBe(302);
    expect(whereTo(forced)).toBe(`${ORIGIN}/admin/account?error=oauth_browser`);
    expect(await states()).toBe(0);
    expect(browser.writes).toEqual([]);
    expect(flowCookies(victim)).toEqual([]);
    expect(fetched).toEqual([]);
    // 也不占這個人按登入的額度(別的網站不能拿這個把他的額度敲光)。
    expect((await d1().prepare("SELECT count(*) AS c FROM login_attempts").first<{ c: number }>())?.c).toBe(0);
    // header 的大小寫不影響。
    expect(whereTo(await start(LINK, { "sec-fetch-site": "cross-site" }))).toBe(`${ORIGIN}/admin/account?error=oauth_browser`);
    expect(await states()).toBe(0);
  });

  it("沒登入的人也一樣不開始", async () => {
    openIn(new Map());
    expect(whereTo(await start(LINK, { "Sec-Fetch-Site": "cross-site" }))).toBe(`${ORIGIN}/admin/account?error=oauth_browser`);
    expect(await states()).toBe(0);
  });

  it.each([
    ["站內按的(same-origin)", "same-origin"],
    ["同一個網站的另一個子網域(same-site)", "same-site"],
    ["自己打網址、書籤(none)", "none"],
    ["舊瀏覽器,沒有這個 header", null],
  ])("照舊開始連結:%s", async (_name, site) => {
    await seedUser("u-owner", "editor");
    const owner: Jar = new Map();
    await signedIn(owner, "u-owner");
    openIn(owner);
    const flow = await start(LINK, site ? { "Sec-Fetch-Site": site } : {});
    expect(`${flow.location.origin}${flow.location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(await stateRows(flow.state)).toBe(1);
    expect(flowCookies(owner)).toHaveLength(1);
    // 走得完。
    await approve(flow, { sub: `sub-${site ?? "old"}`, email: "owner@test.com" });
    expect(await callback({ code: "c", state: flow.state })).toBe("/admin/account?linked=1");
  });

  it("登入模式不受影響:從別的網站連過來按登入是正常的", async () => {
    const flow = await start("next=%2Fadmin", { "Sec-Fetch-Site": "cross-site" });
    expect(`${flow.location.origin}${flow.location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(await stateRows(flow.state)).toBe(1);
    expect(flowCookies(browser.jar)).toHaveLength(1);
  });
});

describe("callback:開始登入的那個瀏覽器", () => {
  it("登入成功:建 session、清掉這一次的 cookie、state 用掉", async () => {
    const flow = await start("next=%2Fshop%2Fcheckout");
    const name = await cookieNameOf(flow.state);
    expect(browser.jar.has(name)).toBe(true);

    await approve(flow, { sub: "sub-1", email: "buyer@test.com" });
    browser.writes = [];
    expect(await callback({ code: "auth-code", state: flow.state })).toBe("/shop/checkout");

    expect(browser.jar.has(name)).toBe(false);
    expect(browser.writes).toContainEqual({
      name,
      value: "",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/oauth", maxAge: 0 },
    });
    expect(await userOfSession(browser.jar)).toBe(await userOfIdentity("sub-1"));
    expect(await userOfIdentity("sub-1")).toEqual(expect.any(String));
    expect(await stateRows(flow.state)).toBe(0);
    expect(hookState.events).toEqual([
      { userId: await userOfIdentity("sub-1"), method: "oauth", provider: PROVIDER, emailVerified: true },
    ]);
  });

  it("登入失敗(對方給的 id_token 不對)也清掉這一次的 cookie", async () => {
    const logged = quietLog();
    try {
      const flow = await start();
      const name = await cookieNameOf(flow.state);
      await approve({ ...flow, nonce: "someone-elses" }, { sub: "sub-2", email: "x@test.com" });
      expect(await callback({ code: "auth-code", state: flow.state })).toBe("/login?error=oauth_failed");
      expect(browser.jar.has(name)).toBe(false);
      expect(browser.jar.has("session")).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });

  it("在對方那邊按了取消:照舊說取消,清掉 cookie", async () => {
    const flow = await start("next=%2Fshop&back=%2Fmember%2Fsign-in");
    expect(await callback({ error: "access_denied", state: flow.state })).toBe("/member/sign-in?login_error=oauth_denied");
    expect(flowCookies(browser.jar)).toEqual([]);
    expect(await stateRows(flow.state)).toBe(0);
  });
});

describe("callback:不是開始登入的那個瀏覽器,或不是那個人", () => {
  it("state 是真的、但這個瀏覽器沒有 cookie:不登入、不換 token、state 留著,開始的那個瀏覽器照樣完成", async () => {
    const logged = quietLog();
    try {
      const owner: Jar = new Map();
      const other: Jar = new Map();
      openIn(owner);
      const flow = await start();
      await approve(flow, { sub: "sub-owner", email: "owner@test.com" });

      openIn(other);
      expect(await callback({ code: "auth-code", state: flow.state })).toBe("/login?error=oauth_browser");
      expect(other.has("session")).toBe(false);
      expect(tokenCalls()).toBe(0);
      expect(await stateRows(flow.state)).toBe(1);
      expect(await userOfIdentity("sub-owner")).toBeUndefined();
      expect(hookState.events).toEqual([]);
      // 伺服器記一行是哪一種拒絕;沒有 state、code。
      expect(logged.mock.calls).toEqual([["[oidc] sign-in refused", PROVIDER, "browser_mismatch"]]);

      openIn(owner);
      expect(await callback({ code: "auth-code", state: flow.state })).toBe("/admin");
      expect(await userOfSession(owner)).toBe(await userOfIdentity("sub-owner"));
      expect(tokenCalls()).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("回到開始登入的那一頁(back),帶著自己的錯誤碼", async () => {
    const logged = quietLog();
    try {
      const owner: Jar = new Map();
      openIn(owner);
      const flow = await start("next=%2Fshop%2Forders&back=%2Fmember%2Fsign-in%3Fnext%3D%252Fshop%252Forders");
      openIn(new Map());
      expect(await callback({ code: "auth-code", state: flow.state })).toBe(
        "/member/sign-in?next=%2Fshop%2Forders&login_error=oauth_browser",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("別人開始的登入帶著會化簡成別的網站的 back:打開那個 callback 的人留在站內", async () => {
    const logged = quietLog();
    try {
      openIn(new Map());
      const planted = await start(`next=%2Fadmin&back=${encodeURIComponent("/..//evil.test")}`);
      openIn(new Map());
      // callback() 會確認去處在站內。
      expect(await callback({ code: "c", state: planted.state })).toBe("/login?error=oauth_browser");
    } finally {
      logged.mockRestore();
    }
  });

  it("login CSRF:別人開始的登入(他的 code、他的 state)送到受害者的瀏覽器,受害者不會登入成那個人", async () => {
    const logged = quietLog();
    try {
      const attacker: Jar = new Map();
      const victim: Jar = new Map();
      // 受害者自己也有一次登入正在進行:有 cookie,但那是另一次登入的。
      openIn(victim);
      const own = await start();
      openIn(attacker);
      const planted = await start();
      await approve(planted, { sub: "sub-attacker", email: "attacker@test.com" });

      openIn(victim);
      expect(await callback({ code: "attacker-code", state: planted.state })).toBe("/login?error=oauth_browser");
      expect(victim.has("session")).toBe(false);
      expect(await userOfIdentity("sub-attacker")).toBeUndefined();
      expect(tokenCalls()).toBe(0);
      // 受害者自己那一次不受影響:cookie 還在,照樣完成,進的是自己的帳號。
      expect(victim.has(await cookieNameOf(own.state))).toBe(true);
      await approve(own, { sub: "sub-victim", email: "victim@test.com" });
      expect(await callback({ code: "victim-code", state: own.state })).toBe("/admin");
      expect(await userOfSession(victim)).toBe(await userOfIdentity("sub-victim"));
    } finally {
      logged.mockRestore();
    }
  });

  it("cookie 的名字對、內容不對:拒絕,而且清掉", async () => {
    const logged = quietLog();
    try {
      const owner: Jar = new Map();
      openIn(owner);
      const flow = await start();
      await approve(flow, { sub: "sub-3", email: "three@test.com" });

      const forged: Jar = new Map([
        [await cookieNameOf(flow.state), { value: `${await sha256b64url("0".repeat(64))}.abc`, options: { path: "/api/auth/oauth" } }],
      ]);
      openIn(forged);
      expect(await callback({ code: "auth-code", state: flow.state })).toBe("/login?error=oauth_browser");
      expect(forged.has("session")).toBe(false);
      expect(flowCookies(forged)).toEqual([]);
      expect(await stateRows(flow.state)).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("連結模式一樣:別的瀏覽器完成不了,身分不會掛到開始的那個帳號上", async () => {
    const logged = quietLog();
    try {
      await seedUser("u-owner", "editor");
      const owner: Jar = new Map();
      await signedIn(owner, "u-owner");
      openIn(owner);
      const flow = await start("mode=link&next=%2Fadmin%2Faccount");
      expect(flow.state).toMatch(/^[0-9a-f]{64}$/);

      // 拿到授權網址的人在自己的瀏覽器、用自己在對方那邊的身分走完。
      await approve(flow, { sub: "sub-intruder", email: "intruder@test.com" });
      openIn(new Map());
      expect(await callback({ code: "intruder-code", state: flow.state })).toBe("/admin/account?error=oauth_browser");
      expect(await listUserIdentities("u-owner")).toEqual([]);
      expect(tokenCalls()).toBe(0);
      expect(await stateRows(flow.state)).toBe(1);

      // 帳號的主人在自己的瀏覽器完成:掛上的是他自己的身分。
      await approve(flow, { sub: "sub-owner", email: "owner@test.com" });
      openIn(owner);
      expect(await callback({ code: "owner-code", state: flow.state })).toBe("/admin/account?linked=1");
      expect(await listUserIdentities("u-owner")).toMatchObject([{ provider: PROVIDER, display: "owner@test.com" }]);
      expect(await userOfIdentity("sub-intruder")).toBeUndefined();
    } finally {
      logged.mockRestore();
    }
  });

  it("連結模式:別人的連結流程送到已登入的受害者那裡,受害者的帳號不會多一個身分", async () => {
    const logged = quietLog();
    try {
      await seedUser("u-attacker", "guest");
      await seedUser("u-victim", "admin");
      const attacker: Jar = new Map();
      const victim: Jar = new Map();
      await signedIn(attacker, "u-attacker");
      await signedIn(victim, "u-victim");
      openIn(attacker);
      const planted = await start("mode=link&next=%2Fadmin%2Faccount");
      await approve(planted, { sub: "sub-attacker", email: "attacker@test.com" });

      openIn(victim);
      expect(await callback({ code: "attacker-code", state: planted.state })).toBe("/admin/account?error=oauth_browser");
      expect(await listUserIdentities("u-victim")).toEqual([]);
      expect(await listUserIdentities("u-attacker")).toEqual([]);
      expect(await userOfSession(victim)).toBe("u-victim");
    } finally {
      logged.mockRestore();
    }
  });

  // cookie 是 state 的雜湊:知道 state 的人(看得到授權網址)在自己的瀏覽器做得出來。
  // 登入模式他只會登入成自己;連結模式多一道 —— 完成的瀏覽器要登入著開始連結的那個帳號。
  it.each([
    ["沒登入", false],
    ["登入的是自己的帳號", true],
  ])("連結模式:知道 state 的人自己做出 cookie、在自己的瀏覽器走完(%s),身分掛不上去", async (_name, intruderSignedIn) => {
    const logged = quietLog();
    try {
      await seedUser("u-owner", "admin");
      await seedUser("u-intruder", "guest");
      const owner: Jar = new Map();
      await signedIn(owner, "u-owner");
      openIn(owner);
      const flow = await start("mode=link&next=%2Fadmin%2Faccount");

      const intruder: Jar = new Map([
        [await cookieNameOf(flow.state), { value: `${await sha256b64url(flow.state)}.${Date.now().toString(36)}`, options: { path: "/api/auth/oauth" } }],
      ]);
      if (intruderSignedIn) await signedIn(intruder, "u-intruder");
      await approve(flow, { sub: "sub-intruder", email: "intruder@test.com" });
      openIn(intruder);
      expect(await callback({ code: "intruder-code", state: flow.state })).toBe("/admin/account?error=oauth_browser");
      expect(await listUserIdentities("u-owner")).toEqual([]);
      expect(await listUserIdentities("u-intruder")).toEqual([]);
      expect(await userOfIdentity("sub-intruder")).toBeUndefined();
      expect(tokenCalls()).toBe(0);
      expect(logged.mock.calls).toEqual([["[oidc] sign-in refused", PROVIDER, "link_other_account"]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("連結模式:同一個瀏覽器換了人登入,前一個人開始的連結完成不了", async () => {
    const logged = quietLog();
    try {
      await seedUser("u-first", "editor");
      await seedUser("u-second", "guest");
      const shared: Jar = new Map();
      await signedIn(shared, "u-first");
      openIn(shared);
      const flow = await start("mode=link&next=%2Fadmin%2Faccount");

      // 第一個人登出,第二個人在同一個瀏覽器登入,然後在對方那邊同意了那一次。
      await signedIn(shared, "u-second");
      await approve(flow, { sub: "sub-second", email: "second@test.com" });
      expect(await callback({ code: "c", state: flow.state })).toBe("/admin/account?error=oauth_browser");
      expect(await listUserIdentities("u-first")).toEqual([]);
      expect(await listUserIdentities("u-second")).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it("別的瀏覽器收到「取消」:說取消,state 留著", async () => {
    const owner: Jar = new Map();
    openIn(owner);
    const flow = await start("next=%2Fshop&back=%2Fmember%2Fsign-in");
    openIn(new Map());
    expect(await callback({ error: "access_denied", state: flow.state })).toBe("/member/sign-in?login_error=oauth_denied");
    expect(await stateRows(flow.state)).toBe(1);
  });

  it("state 已經不在(等太久、用過、亂填):照舊是「等太久」,不是「換了瀏覽器」", async () => {
    expect(await callback({ code: "c", state: "f".repeat(64) })).toBe("/login?error=oauth_state");
    expect(await callback({ code: "c", state: "not-a-state" })).toBe("/login?error=oauth_state");
    expect(await callback({ code: "c", state: "f".repeat(4000) })).toBe("/login?error=oauth_state");
    expect(await callback({ code: "c" })).toBe("/login?error=oauth_state");
    expect(await callback({ error: "access_denied" })).toBe("/login?error=oauth_denied");
    expect(browser.jar.has("session")).toBe(false);
    expect(tokenCalls()).toBe(0);
  });
});

describe("oauth-flow-cookie:純函式", () => {
  const stateOf = (n: number): string => n.toString(16).padStart(64, "0");

  function fakeStore(initial: Record<string, string> = {}) {
    const jar = new Map(Object.entries(initial));
    const writes: { name: string; value: string; maxAge: number }[] = [];
    return {
      jar,
      writes,
      get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string, options: { maxAge: number }) => {
        writes.push({ name, value, maxAge: options.maxAge });
        if (options.maxAge === 0) jar.delete(name);
        else jar.set(name, value);
      },
    };
  }

  it("雜湊是 SHA-256 的 base64url(43 字),名字取前 8 字", async () => {
    const hash = await oauthStateHash(stateOf(1));
    expect(hash).toBe(await sha256b64url(stateOf(1)));
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(oauthFlowCookieName(hash)).toBe(`oauth_flow_${hash.slice(0, 8)}`);
  });

  it("超過上限時先丟最舊的;看不懂的值當最舊;別的 cookie 不動", async () => {
    const store = fakeStore({ session: "keep-me", oauth_flow_garbage0: "not-a-flow-value" });
    const nameOf = async (n: number) => oauthFlowCookieName(await oauthStateHash(stateOf(n)));
    const held = () => [...store.jar.keys()].filter((name) => name.startsWith("oauth_flow_"));
    const bind = (n: number) => bindOAuthFlow(store, stateOf(n), 1_000 * n);

    // 一個看不懂的 + (上限 - 1) 次登入:剛好滿,還沒有東西被丟。
    for (let n = 1; n < MAX_OAUTH_FLOWS; n++) await bind(n);
    expect(held()).toHaveLength(MAX_OAUTH_FLOWS);
    expect(store.jar.has("oauth_flow_garbage0")).toBe(true);

    // 再一次:丟掉看不懂的那個。
    await bind(MAX_OAUTH_FLOWS);
    expect(held()).toHaveLength(MAX_OAUTH_FLOWS);
    expect(store.jar.has("oauth_flow_garbage0")).toBe(false);
    expect(store.jar.has(await nameOf(1))).toBe(true);

    // 再一次:丟最舊的(第 1 次),其餘都在。
    await bind(MAX_OAUTH_FLOWS + 1);
    expect(held()).toHaveLength(MAX_OAUTH_FLOWS);
    expect(store.jar.has(await nameOf(1))).toBe(false);
    for (let n = 2; n <= MAX_OAUTH_FLOWS + 1; n++) expect(store.jar.has(await nameOf(n))).toBe(true);

    // 時間寫在未來的(不是我們設的)不算新:下一次先丟它。
    store.jar.delete(await nameOf(2));
    store.jar.set("oauth_flow_future00", `${await oauthStateHash(stateOf(999))}.${(9e15).toString(36)}`);
    await bind(MAX_OAUTH_FLOWS + 2);
    expect(store.jar.has("oauth_flow_future00")).toBe(false);
    expect(store.jar.has(await nameOf(3))).toBe(true);
    expect(store.jar.get("session")).toBe("keep-me");
  });

  it("takeOAuthFlow:對得上才是 true,而且只碰這一次的 cookie", async () => {
    const store = fakeStore();
    const [first, second, unknown] = [stateOf(0xa1), stateOf(0xb2), stateOf(0xc3)];
    await bindOAuthFlow(store, first, 1_000);
    await bindOAuthFlow(store, second, 2_000);
    const secondName = oauthFlowCookieName(await oauthStateHash(second));

    expect(await takeOAuthFlow(store, unknown)).toBe(false);
    expect(await takeOAuthFlow(store, null)).toBe(false);
    expect(await takeOAuthFlow(store, "not-a-state")).toBe(false);
    expect(await takeOAuthFlow(store, first.toUpperCase())).toBe(false);
    expect(store.jar.size).toBe(2);
    expect(store.writes.filter((write) => write.maxAge === 0)).toEqual([]);

    expect(await takeOAuthFlow(store, first)).toBe(true);
    expect([...store.jar.keys()]).toEqual([secondName]);
    // 用過就沒有了:同一個網址再開一次對不上。
    expect(await takeOAuthFlow(store, first)).toBe(false);

    // 名字對、值不對:不算,而且清掉。
    store.jar.set(secondName, `${await oauthStateHash(unknown)}.${(2_000).toString(36)}`);
    expect(await takeOAuthFlow(store, second)).toBe(false);
    expect(store.jar.size).toBe(0);
  });
});

// Firebase 那條路沒有「對方把瀏覽器送回來」這一步:瀏覽器拿到 ID token 後自己 POST。
// 擋 login CSRF 的是 same-origin 檢查 —— 外站沒辦法把它自己的 token 送進訪客的瀏覽器換 session。
describe("Firebase 登入:外站送不進來", () => {
  const post = (origin: string | null) =>
    firebaseRoute(
      new Request(`${ORIGIN}/api/auth/firebase/${PROVIDER}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ idToken: "x".repeat(40), mode: "login" }),
      }),
      ctx,
    );

  it.each([
    ["別的網站", "https://evil.test"],
    ["同站的另一個子網域", "https://shop.cms.test"],
    ["沒有 Origin", null],
    ["Origin: null", "null"],
  ])("%s:403,不設任何 cookie", async (_name, origin) => {
    const res = await post(origin);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
    expect(browser.writes).toEqual([]);
  });
});
