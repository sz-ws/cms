import { eq } from "drizzle-orm";
import { db } from "./db";
import { getDB } from "./cf";
import { declarativeExtensions as dxTable, userIdentities } from "./schema";
import { getSetting, extSetting } from "./settings";
import { linkIdentity, signInWithIdentity, SENTINEL_PASSWORD_HASH } from "./login-accounts";
import { OAUTH_STATE_TTL_MS, isOAuthState } from "./oauth-flow-cookie";
import { OidcError, bytes, encUtf8, normalizeIssuer, verifyJwt, type Jwk } from "./oidc-jwt";
import {
  FIREBASE_SETTING_KEYS,
  parseManifest,
  type DeclarativeLoginProvider,
} from "@/ext/dx/manifest";

// spec-login-providers.md §5:core OIDC 引擎(role-agnostic;第三方身分只對應 user
// 列,role/permission 全走既有機制)。Google(RS256)/ LINE(網頁登入 HS256,App 與 LIFF 是 ES256)皆標準 OIDC
// authorization code flow + discovery,簽章驗證由 WebCrypto 原生做。
//
// 安全硬需求:
//   - 錯誤訊息永不含 clientSecret;外部 fetch 一律 https + SSRF host guard + timeout。
//   - id_token 完整驗證(alg allowlist、JWKS 簽章、iss/aud/exp/nonce)。
//   - state 一次性(callback 條件式 DELETE,防重放);email 撞既有 user 不自動綁。
//   - 1.76.0:state 綁在開始登入的那個瀏覽器上(oauth-flow-cookie.ts)。callback route 先確認瀏覽器帶著
//     這一次的 cookie 才呼叫 completeOAuth;對不上就交給 refuseUnboundCallback,什麼都不完成、state 不取用。
//     連結模式再多一道:完成時這個瀏覽器要登入著開始連結的那個帳號。
//
// id_token 的驗證(verifyJwt)在 oidc-jwt.ts;這裡重新匯出,別的地方照舊從這個檔 import。

export { verifyJwt };

// ---- 型別 ----

/** Firebase 的 web config(本來就會出現在頁面上)與登入方式。 */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  signIn: string;
}

/**
 * 登入頁/帳號頁/會員元件渲染用的 provider 摘要(設定齊全者才列出)。
 * kind "oidc" 走 /api/auth/oauth/<id>/start 導轉;"firebase" 在瀏覽器彈出 Firebase 登入。
 */
export interface LoginProviderInfo {
  id: string;
  kind: "oidc" | "firebase";
  label: string;
  svg?: string;
  background?: string;
  foreground?: string;
  firebase?: FirebaseWebConfig;
}

/** completeOAuth 的結果。route handler 依 kind 決定是否建 session / 設 cookie。 */
export type OAuthOutcome =
  | { kind: "redirect"; location: string }
  // 1.56.0:emailVerified = 這次登入證明了帳號的 Email(見 login-accounts.ts)。
  | { kind: "session"; userId: string; location: string; emailVerified: boolean };

export type OAuthMode = "login" | "link";

interface StatePayload {
  provider: string;
  nonce: string;
  verifier: string;
  mode: OAuthMode;
  userId?: string;
  next?: string;
  /** 登入失敗時回到的站內路徑(帶 ?login_error=<code>);沒有就回 /login。 */
  back?: string;
}

interface LoadedProvider {
  loginProvider: DeclarativeLoginProvider & { issuer: string };
  clientId: string;
  clientSecret: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h(isolate 內 in-memory)
const DEFAULT_SCOPES = ["openid", "profile", "email"];

// ---- base64url / bytes helpers(bytes、encUtf8 與解碼在 oidc-jwt.ts)----

function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes(len));
}
const toHex = (u8: Uint8Array): string =>
  Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function b64urlEncode(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- SSRF guard(spec §5:issuer 必須 https 且非 private/loopback host)----
// registry-client 的既有 guard 是「同 host redirect + 白名單」式,無可複用的
// private-host helper,故此處抽一個。runtime 另有 wrangler `global_fetch_strictly_public`
// flag 於 workerd 層擋私網 fetch —— 此函式是 defense-in-depth,並讓非法 issuer
// 在驗證當下就以可讀 code 拒絕。

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const oct = m.slice(1).map((n) => Number(n));
  if (oct.some((n) => n > 255)) return true; // 非法八位元 → 保守擋
  const [a, b] = oct;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16(含雲端 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
    return true; // link-local fe80::/10
  // IPv4-mapped ::ffff:a.b.c.d → 抽出尾段 IPv4 再判。
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isPrivateHost(hostRaw: string): boolean {
  const host = stripBrackets(hostRaw.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return isPrivateIpv6(host); // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host); // IPv4 literal
  // bare 單標籤 host(無 dot、非 IP)不可能是公開 FQDN → 保守擋(如 "metadata")。
  if (!host.includes(".")) return true;
  return false;
}

function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OidcError("bad_url");
  }
  if (u.protocol !== "https:") throw new OidcError("insecure_url");
  if (isPrivateHost(u.hostname)) throw new OidcError("private_host");
}

// ---- bounded fetch(https + SSRF guard + timeout;redirect 一律拒)----
//
// 拒絕轉址的寫法是 redirect: "manual" 加 res.ok:轉址的回應(3xx)不是 ok,照 http_3xx 擋掉,
// 不會跟過去。不能寫 redirect: "error" —— Workers 的 fetch 不支援,一呼叫就丟 TypeError,
// 每一次登入都變成 fetch_failed(1.67.0 之前正式站的 Google / LINE 登入就是這樣全部失敗;
// 測試裡的 fetch 是假的,看不出來)。

async function fetchJson(url: string): Promise<unknown> {
  assertPublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    if (!res.ok) throw new OidcError(`http_${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError("fetch_failed"); // 訊息不外洩上游細節 / 不含 secret
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<unknown> {
  assertPublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const body = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!res.ok) throw new OidcError(`token_http_${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError("token_fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBearerJson(url: string, accessToken: string): Promise<unknown> {
  assertPublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) throw new OidcError(`userinfo_http_${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError("userinfo_fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

// ---- discovery + JWKS cache(isolate 內 in-memory,TTL 1h)----

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, { at: number; value: Jwk[] }>();

async function getDiscovery(issuer: string): Promise<Discovery> {
  assertPublicHttpsUrl(issuer);
  const key = normalizeIssuer(issuer);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.value;

  const url = `${key}/.well-known/openid-configuration`;
  const doc = (await fetchJson(url)) as Partial<Discovery> | null;
  if (
    !doc ||
    typeof doc.issuer !== "string" ||
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new OidcError("discovery_malformed");
  }
  // OIDC 硬規則:discovery 的 issuer 欄位必須與請求 issuer 一致(防混淆攻擊)。
  if (normalizeIssuer(doc.issuer) !== key) throw new OidcError("issuer_mismatch");

  const value: Discovery = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    userinfo_endpoint:
      typeof doc.userinfo_endpoint === "string" ? doc.userinfo_endpoint : undefined,
  };
  discoveryCache.set(key, { at: now, value });
  return value;
}

/** JWKS(isolate 內快取 1h;https + SSRF guard)。Firebase 登入也用這一份。 */
export async function getJwks(jwksUri: string): Promise<Jwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.value;
  const doc = (await fetchJson(jwksUri)) as { keys?: unknown } | null;
  if (!doc || !Array.isArray(doc.keys)) throw new OidcError("jwks_malformed");
  const keys = doc.keys as Jwk[];
  jwksCache.set(jwksUri, { at: now, value: keys });
  return keys;
}

/** 測試用:清 isolate 內 discovery/JWKS cache(pool-workers 跨 case 隔離)。 */
export function __clearOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

// ---- provider 載入(manifest loginProvider + settings clientId/secret)----

async function loadProvider(providerId: string): Promise<LoadedProvider | null> {
  const rows = await db()
    .select({ manifest: dxTable.manifest, enabled: dxTable.enabled })
    .from(dxTable)
    .where(eq(dxTable.id, providerId))
    .limit(1);
  const row = rows[0];
  if (!row || row.enabled !== 1) return null;
  const parsed = parseManifest(JSON.parse(row.manifest));
  const lp = parsed.ok ? parsed.manifest?.loginProvider : undefined;
  // Firebase 的 provider 不走導轉流程(見 firebase-login.ts)。
  if (!lp || lp.issuer === undefined) return null;
  const issuer = lp.issuer;

  const clientId = await getSetting<string>(extSetting(providerId, "clientId"), "");
  const clientSecret = await getSetting<string>(
    extSetting(providerId, "clientSecret"),
    "",
  );
  if (!clientId || !clientSecret) return null; // 未設定 → 視為未啟用
  return { loginProvider: { ...lp, issuer }, clientId, clientSecret };
}

/**
 * 列舉可用的登入 provider(enabled declarative extension 含 loginProvider 且
 * clientId/clientSecret 皆已設定者)。給登入頁/帳號頁渲染。
 */
export async function listLoginProviders(): Promise<LoginProviderInfo[]> {
  const rows = await db()
    .select({ id: dxTable.id, manifest: dxTable.manifest })
    .from(dxTable)
    .where(eq(dxTable.enabled, 1));
  const out: LoginProviderInfo[] = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = parseManifest(JSON.parse(row.manifest));
    } catch {
      continue;
    }
    const lp = parsed.ok ? parsed.manifest?.loginProvider : undefined;
    if (!lp) continue;
    const button = {
      id: row.id,
      label: lp.button.label,
      svg: lp.button.svg,
      background: lp.button.background,
      foreground: lp.button.foreground,
    };
    // 兩種都宣告時(1.57.0):Firebase 設定填齊就用 Firebase,否則看 OIDC 的設定。
    if (lp.firebase) {
      const firebase = await loadFirebaseConfig(row.id, lp.firebase.signIn);
      if (firebase) {
        out.push({ ...button, kind: "firebase", firebase });
        continue;
      }
    }
    if (lp.issuer === undefined) continue;
    const clientId = await getSetting<string>(extSetting(row.id, "clientId"), "");
    const clientSecret = await getSetting<string>(
      extSetting(row.id, "clientSecret"),
      "",
    );
    if (!clientId || !clientSecret) continue;
    out.push({ ...button, kind: "oidc" });
  }
  return out;
}

/** Firebase provider 的 web config;任一個沒填 → null(視為未啟用)。 */
export async function loadFirebaseConfig(
  providerId: string,
  signIn: string,
): Promise<FirebaseWebConfig | null> {
  const [apiKey, authDomain, projectId] = await Promise.all(
    FIREBASE_SETTING_KEYS.map((key) => getSetting<string>(extSetting(providerId, key), "")),
  );
  if (!apiKey?.trim() || !authDomain?.trim() || !projectId?.trim()) return null;
  return { apiKey: apiKey.trim(), authDomain: authDomain.trim(), projectId: projectId.trim(), signIn };
}

// ---- state 表存取(一次性,照 webauthn_challenges precedent)----

async function insertState(id: string, payload: StatePayload): Promise<void> {
  // 10 分鐘;綁定瀏覽器的 cookie 用同一個數字當 Max-Age。
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  await getDB()
    .prepare("INSERT INTO oauth_states (id, payload, expires_at) VALUES (?1, ?2, ?3)")
    .bind(id, JSON.stringify(payload), expiresAt)
    .run();
}

/** 單次消費 state:條件式 DELETE WHERE id=? AND expires_at>now;順手清過期列。 */
async function consumeState(id: string): Promise<StatePayload | null> {
  const now = Date.now();
  await getDB()
    .prepare("DELETE FROM oauth_states WHERE expires_at < ?1")
    .bind(now)
    .run();
  const found = await getDB()
    .prepare("SELECT payload FROM oauth_states WHERE id = ?1 AND expires_at > ?2")
    .bind(id, now)
    .first<{ payload: string }>();
  if (!found) return null;
  const res = await getDB()
    .prepare("DELETE FROM oauth_states WHERE id = ?1 AND expires_at > ?2")
    .bind(id, now)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null; // 競態下已被取走 → 拒絕(防重放)
  return parseStatePayload(found.payload);
}

/** 只看不取:state 還在、沒過期就回它的內容(refuseUnboundCallback 用)。 */
async function peekState(id: string): Promise<StatePayload | null> {
  const found = await getDB()
    .prepare("SELECT payload FROM oauth_states WHERE id = ?1 AND expires_at > ?2")
    .bind(id, Date.now())
    .first<{ payload: string }>();
  return found ? parseStatePayload(found.payload) : null;
}

function parseStatePayload(raw: string): StatePayload | null {
  try {
    return JSON.parse(raw) as StatePayload;
  } catch {
    return null;
  }
}

// ---- origin / next helpers ----

/** redirect_uri 的 origin:優先 core.siteUrl(https),否則 request origin。 */
async function resolveOrigin(req: Request): Promise<string> {
  const site = await getSetting<string>("core.siteUrl", "");
  if (site) {
    try {
      const u = new URL(site);
      if (u.protocol === "https:") return u.origin;
    } catch {
      // 忽略無效 siteUrl,退回 request origin。
    }
  }
  return new URL(req.url).origin;
}

/** 同站絕對路徑(以單一 "/" 起頭、非 "//"、無反斜線與控制字元)才算數。 */
function sitePath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  if (/[\x00-\x1F\x7F]/.test(path)) return null;
  return path;
}

/** 成功後去哪:同站路徑,否則 "/admin"。 */
export function safeNext(next: string | null | undefined): string {
  return sitePath(next) ?? "/admin";
}

/** 失敗時去哪:有 back 就回那一頁(帶 login_error),否則後台登入頁(帶 error)。 */
export function loginErrorLocation(code: string, back?: string | null): string {
  const fallback = `/login?error=${encodeURIComponent(code)}`;
  const path = sitePath(back);
  if (!path) return fallback;
  const url = new URL(path, "https://site.invalid");
  url.searchParams.set("login_error", code);
  // 化簡完再驗一次:"/..//evil.test" 過得了上面的檢查,化簡之後卻是 "//evil.test",
  // 瀏覽器(和 route 的 new URL)會把它當成別的網站。
  return sitePath(`${url.pathname}${url.search}${url.hash}`) ?? fallback;
}

function redirectUriFor(origin: string, providerId: string): string {
  return `${origin}/api/auth/oauth/${providerId}/callback`;
}

// ---- PKCE ----

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encUtf8(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

// ---- begin(start route 用)----

export interface BeginOptions {
  providerId: string;
  mode: OAuthMode;
  userId?: string; // mode=link 必填(呼叫端已 requireAuth)
  next?: string | null;
  back?: string | null;
  req: Request;
}

/**
 * 產生 state/nonce/PKCE、寫 oauth_states、回 authorization URL。失敗回 error code。
 * state 一起交出來:/start 用它在瀏覽器放綁定的 cookie(oauth-flow-cookie.ts)。
 */
export async function beginOAuth(
  opts: BeginOptions,
): Promise<{ location: string; state: string } | { error: string }> {
  const provider = await loadProvider(opts.providerId);
  if (!provider) return { error: "provider_unavailable" };

  let discovery: Discovery;
  try {
    discovery = await getDiscovery(provider.loginProvider.issuer);
  } catch (e) {
    return { error: e instanceof OidcError ? e.message : "discovery_failed" };
  }

  const state = toHex(randomBytes(32));
  const nonce = toHex(randomBytes(16));
  const verifier = b64urlEncode(randomBytes(32));
  const challenge = await pkceChallenge(verifier);

  const payload: StatePayload = {
    provider: opts.providerId,
    nonce,
    verifier,
    mode: opts.mode,
    userId: opts.mode === "link" ? opts.userId : undefined,
    next: safeNext(opts.next),
    back: sitePath(opts.back) ?? undefined,
  };
  await insertState(state, payload);

  const origin = await resolveOrigin(opts.req);
  const scopes = provider.loginProvider.scopes ?? DEFAULT_SCOPES;
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set("client_id", provider.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriFor(origin, opts.providerId));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  return { location: authUrl.toString(), state };
}

// ---- complete(callback route 用)----

export interface CompleteOptions {
  providerId: string;
  code: string | null;
  state: string | null;
  error?: string | null;
  req: Request;
  /**
   * 1.76.0:這個瀏覽器現在登入的是誰(沒登入是 null)。只有連結模式會問:完成連結的人要是開始的那個帳號。
   * 函式而不是值:登入模式不必為了它多查一次 session。
   */
  sessionUserId: () => Promise<string | null>;
}

/**
 * callback 主流程。回傳 OAuthOutcome —— route 依 kind 設 cookie / redirect。
 * 所有錯誤都轉為帶機器可讀 error code 的 redirect:有 back 就回那一頁(?login_error=),
 * 否則後台登入頁(?error=);連結模式回帳號頁。
 *
 * 呼叫前 route 要先確認瀏覽器帶著這一次登入的 cookie(takeOAuthFlow);這裡不看 cookie。
 * 連結模式另外要求這個瀏覽器登入著開始連結的那個帳號(sessionUserId)。
 */
export async function completeOAuth(opts: CompleteOptions): Promise<OAuthOutcome> {
  const redirect = (location: string): OAuthOutcome => ({ kind: "redirect", location });
  const accountRedirect = (q: string): OAuthOutcome => redirect(`/admin/account?${q}`);

  // state 拿不到就不知道 back,只能回後台登入頁。
  if (!opts.state) {
    return redirect(loginErrorLocation(opts.error ? "oauth_denied" : "oauth_state"));
  }

  // 1) state 一次性取用(IdP 回錯誤時也帶 state,取掉它才知道要回哪一頁)。
  const payload = await consumeState(opts.state);
  if (!payload || payload.provider !== opts.providerId) {
    return redirect(loginErrorLocation(opts.error ? "oauth_denied" : "oauth_state"));
  }

  const isLink = payload.mode === "link";
  const fail = (code: string): OAuthOutcome =>
    isLink ? accountRedirect(`error=${code}`) : redirect(loginErrorLocation(code, payload.back));
  if (opts.error) return fail(isLink ? "oauth_failed" : "oauth_denied");
  if (!opts.code) return fail("oauth_state");

  // 連結模式:身分要掛到「開始的那個帳號」上,所以完成的這個瀏覽器也要登入著同一個帳號。
  // 綁定的 cookie 是 state 的雜湊,知道 state 的人(例如看得到授權網址)做得出來;他在自己的瀏覽器
  // 用自己在對方那邊的身分走完,少了這一步,他的身分就掛上去了(之後能用它登入這個帳號)。
  // 同一台電腦換了人登入也一樣擋。
  if (isLink && (!payload.userId || (await opts.sessionUserId()) !== payload.userId)) {
    console.error("[oidc] sign-in refused", opts.providerId, "link_other_account");
    return fail("oauth_browser");
  }

  try {
    const provider = await loadProvider(opts.providerId);
    if (!provider) throw new OidcError("provider_unavailable");
    const discovery = await getDiscovery(provider.loginProvider.issuer);
    const origin = await resolveOrigin(opts.req);

    // 2) token exchange(client_secret_post)。
    const token = (await postForm(discovery.token_endpoint, {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: redirectUriFor(origin, opts.providerId),
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: payload.verifier,
    })) as { id_token?: unknown; access_token?: unknown };
    if (typeof token.id_token !== "string") throw new OidcError("no_id_token");

    // 3) id_token 完整驗證。
    const jwks = await getJwks(discovery.jwks_uri);
    const { claims } = await verifyJwt(token.id_token, jwks, {
      issuer: provider.loginProvider.issuer,
      audience: provider.clientId,
      nonce: payload.nonce,
      clientSecret: provider.clientSecret,
    });
    // 明確標記「未驗證」的 email 連這個登入方式的名字(display)都不用。帳號的 Email 另有規則(login-accounts.ts):
    // 只認 email_verified === true 的;缺這個 claim 的(如 LINE)一樣不算,不會變成新帳號的 Email、也不比對既有帳號。
    if (claims.email_verified === false) claims.email = undefined;

    // name 缺 → 打 userinfo 補(LINE 的 profile)。best-effort,失敗不阻斷。
    let displayName = claims.name;
    if ((!displayName || displayName.length === 0) && discovery.userinfo_endpoint && typeof token.access_token === "string") {
      try {
        const info = (await fetchBearerJson(
          discovery.userinfo_endpoint,
          token.access_token,
        )) as { name?: unknown };
        if (typeof info.name === "string") displayName = info.name;
      } catch {
        // 忽略:name fallback 失敗不影響登入。
      }
    }
    const display = claims.email ?? displayName ?? null;

    // 4) 分支。
    if (isLink) {
      if (!payload.userId) throw new OidcError("link_no_user");
      const linked = await linkIdentity(payload.userId, opts.providerId, claims.sub, display);
      return accountRedirect(linked === "linked" ? "linked=1" : "error=identity_taken");
    }

    const result = await signInWithIdentity(
      opts.providerId,
      { ...claims, name: claims.name || displayName },
      display,
      provider.loginProvider.button.label,
    );
    if (!result.ok) return fail(result.code);
    return {
      kind: "session",
      userId: result.userId,
      location: safeNext(payload.next),
      emailVerified: result.emailVerified,
    };
  } catch (error) {
    // 任何引擎錯誤(discovery/token/簽章/DB)→ 帶 oauth_failed 導回。訊息不外洩給使用者;
    // 1.76.0 起在伺服器記一行是哪一步(只有我們自己的代號,例如 unsupported_alg、token_http_400,沒有 token 或 secret),
    // 不然站長只看得到「登入失敗」,查不出原因。
    console.error("[oidc] sign-in failed", opts.providerId, error instanceof OidcError ? error.message : "unexpected");
    return fail("oauth_failed");
  }
}

/**
 * 1.76.0:callback 到了不是開始登入的那個瀏覽器(route 發現綁定的 cookie 沒帶或對不上)。
 * 什麼都不完成,只決定把人送去哪:
 *   - state 還在:回開始的那一頁(沒有就登入頁;連結模式回帳號頁),帶 oauth_browser。手機上很常見
 *     (對方的 App 把人送回另一個瀏覽器),頁面請他在這裡再登入一次。對方回的是錯誤(例如按了取消)
 *     就照舊說取消。
 *   - state 不在(等太久、用過、亂填、別的登入方式的):跟 completeOAuth 一樣是 oauth_state。
 * state 只看不取用:取用了,任何拿得到 callback 網址的人都能把正在登入的那個人的這一次作廢。
 */
export async function refuseUnboundCallback(opts: {
  providerId: string;
  state: string | null;
  error?: string | null;
}): Promise<OAuthOutcome> {
  const redirect = (location: string): OAuthOutcome => ({ kind: "redirect", location });
  const payload = isOAuthState(opts.state) ? await peekState(opts.state) : null;
  if (!payload || payload.provider !== opts.providerId) {
    return redirect(loginErrorLocation(opts.error ? "oauth_denied" : "oauth_state"));
  }
  // 伺服器記一行(只有我們自己的代號):站長看得出「登入失敗」裡有多少是換了瀏覽器。
  if (!opts.error) console.error("[oidc] sign-in refused", opts.providerId, "browser_mismatch");
  if (payload.mode === "link") {
    return redirect(`/admin/account?error=${opts.error ? "oauth_failed" : "oauth_browser"}`);
  }
  return redirect(loginErrorLocation(opts.error ? "oauth_denied" : "oauth_browser", payload.back));
}

// ---- 帳號頁 identities API 用的資料存取 ----

export interface AccountIdentity {
  id: string;
  provider: string;
  display: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** 某 user 的已綁 identities(帳號頁列表用)。 */
export async function listUserIdentities(userId: string): Promise<AccountIdentity[]> {
  const rows = await db()
    .select({
      id: userIdentities.id,
      provider: userIdentities.provider,
      display: userIdentities.display,
      createdAt: userIdentities.createdAt,
      lastUsedAt: userIdentities.lastUsedAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));
  return rows;
}

export { SENTINEL_PASSWORD_HASH };
