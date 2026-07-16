import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { getDB } from "./cf";
import {
  declarativeExtensions as dxTable,
  userIdentities,
  users,
} from "./schema";
import { getSetting, extSetting } from "./settings";
import { PLACEHOLDER_EMAIL_SUFFIX } from "./auth";
import { parseManifest, type DeclarativeLoginProvider } from "@/ext/dx/manifest";

// spec-login-providers.md §5:core OIDC 引擎(role-agnostic;第三方身分只對應 user
// 列,role/permission 全走既有機制)。Google(RS256)/ LINE(ES256)皆標準 OIDC
// authorization code flow + discovery,簽章驗證由 WebCrypto 原生做。
//
// 安全硬需求:
//   - 錯誤訊息永不含 clientSecret;外部 fetch 一律 https + SSRF host guard + timeout。
//   - id_token 完整驗證(alg allowlist、JWKS 簽章、iss/aud/exp/nonce)。
//   - state 一次性(callback 條件式 DELETE,防重放);email 撞既有 user 不自動綁。

// ---- 型別 ----

/** 登入頁/帳號頁渲染用的 provider 摘要(clientId/secret 已設定者才列出)。 */
export interface LoginProviderInfo {
  id: string;
  label: string;
  svg?: string;
  background?: string;
  foreground?: string;
}

/** completeOAuth 的結果。route handler 依 kind 決定是否建 session / 設 cookie。 */
export type OAuthOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "session"; userId: string; location: string };

export type OAuthMode = "login" | "link";

interface StatePayload {
  provider: string;
  nonce: string;
  verifier: string;
  mode: OAuthMode;
  userId?: string;
  next?: string;
}

interface LoadedProvider {
  loginProvider: DeclarativeLoginProvider;
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

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

/** 引擎內部錯誤:message 為機器可讀 code(絕不含 secret / 上游 body 全文)。 */
class OidcError extends Error {}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 分鐘
const FETCH_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h(isolate 內 in-memory)
const DEFAULT_SCOPES = ["openid", "profile", "email"];
const SENTINEL_PASSWORD_HASH = "!oauth-only"; // 非 pbkdf2 格式 → verifyPassword 恆 false

// ---- base64url / bytes helpers ----

function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}
function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes(len));
}
function encUtf8(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = bytes(src.length);
  out.set(src);
  return out;
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
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
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

async function fetchJson(url: string): Promise<unknown> {
  assertPublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "error" });
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
      redirect: "error",
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
      redirect: "error",
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

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

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

async function getJwks(jwksUri: string): Promise<Jwk[]> {
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

// ---- id_token 驗證(alg allowlist + JWKS 簽章 + claims)----

interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

const VERIFY_ALG: Record<string, { import: EcKeyImportParams | RsaHashedImportParams; verify: EcdsaParams | AlgorithmIdentifier }> = {
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
};

async function verifyIdToken(
  idToken: string,
  jwks: Jwk[],
  expected: { issuer: string; clientId: string; nonce: string },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("idtoken_malformed");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecodeToString(headerB64));
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    throw new OidcError("idtoken_malformed");
  }

  const algName = header.alg ?? "";
  const alg = VERIFY_ALG[algName];
  if (!alg) throw new OidcError("unsupported_alg");

  // 依 kid 選 key(無 kid 時取第一把符合 kty 的);import → verify 簽章。
  const wantKty = algName === "RS256" ? "RSA" : "EC";
  const candidates = jwks.filter(
    (k) => k.kty === wantKty && (header.kid ? k.kid === header.kid : true),
  );
  if (candidates.length === 0) throw new OidcError("jwks_no_matching_key");

  const signed = encUtf8(`${headerB64}.${payloadB64}`);
  const sig = b64urlDecode(sigB64);
  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", jwk, alg.import, false, [
        "verify",
      ]);
      if (await crypto.subtle.verify(alg.verify, key, sig, signed)) {
        verified = true;
        break;
      }
    } catch {
      // 這把 key import/verify 失敗 → 試下一把。
    }
  }
  if (!verified) throw new OidcError("idtoken_bad_signature");

  // claims 驗證:iss 一致、aud === clientId、exp > now-60s、nonce 相符。
  if (normalizeIssuer(String(payload.iss ?? "")) !== normalizeIssuer(expected.issuer)) {
    throw new OidcError("idtoken_bad_iss");
  }
  const aud = payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(expected.clientId)
    : aud === expected.clientId;
  if (!audOk) throw new OidcError("idtoken_bad_aud");
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp * 1000 <= Date.now() - 60_000) throw new OidcError("idtoken_expired");
  if (payload.nonce !== expected.nonce) throw new OidcError("idtoken_bad_nonce");

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) throw new OidcError("idtoken_no_sub");

  return {
    sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    email_verified:
      typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
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
  if (!parsed.ok || !parsed.manifest?.loginProvider) return null;

  const clientId = await getSetting<string>(extSetting(providerId, "clientId"), "");
  const clientSecret = await getSetting<string>(
    extSetting(providerId, "clientSecret"),
    "",
  );
  if (!clientId || !clientSecret) return null; // 未設定 → 視為未啟用
  return { loginProvider: parsed.manifest.loginProvider, clientId, clientSecret };
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
    const clientId = await getSetting<string>(extSetting(row.id, "clientId"), "");
    const clientSecret = await getSetting<string>(
      extSetting(row.id, "clientSecret"),
      "",
    );
    if (!clientId || !clientSecret) continue;
    out.push({
      id: row.id,
      label: lp.button.label,
      svg: lp.button.svg,
      background: lp.button.background,
      foreground: lp.button.foreground,
    });
  }
  return out;
}

// ---- state 表存取(一次性,照 webauthn_challenges precedent)----

async function insertState(id: string, payload: StatePayload): Promise<void> {
  const expiresAt = Date.now() + STATE_TTL_MS;
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
  try {
    return JSON.parse(found.payload) as StatePayload;
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

/** 只放行同站絕對路徑(以單一 "/" 起頭、非 "//"、無控制字元);否則退回 "/admin"。 */
function safeNext(next: string | null | undefined): string {
  if (!next) return "/admin";
  if (!next.startsWith("/") || next.startsWith("//")) return "/admin";
  if (/[\x00-\x1F\x7F]/.test(next)) return "/admin";
  return next;
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
  req: Request;
}

/** 產生 state/nonce/PKCE、寫 oauth_states、回 authorization URL。失敗回 error code。 */
export async function beginOAuth(
  opts: BeginOptions,
): Promise<{ location: string } | { error: string }> {
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
  return { location: authUrl.toString() };
}

// ---- complete(callback route 用)----

export interface CompleteOptions {
  providerId: string;
  code: string | null;
  state: string | null;
  error?: string | null;
  req: Request;
}

async function upsertLastUsed(identityId: string): Promise<void> {
  await db()
    .update(userIdentities)
    .set({ lastUsedAt: Date.now() })
    .where(eq(userIdentities.id, identityId));
}

/** 建立 OAuth-only 新帳號(role=guest、sentinel 密碼、真實或 placeholder email)。 */
async function createGuestUser(
  providerId: string,
  claims: IdTokenClaims,
  fallbackName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  // placeholder email(spec §2):`.invalid` TLD 保證不可寄達;sub 前 8 碼 hex 由
  // SHA-256(sub) 取(sub 本身未必是 hex,雜湊後取前 8 hex 保證格式且穩定)。
  const subHex = toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encUtf8(claims.sub))),
  ).slice(0, 8);
  const email =
    claims.email && claims.email.length > 0
      ? claims.email.toLowerCase()
      : `oauth-${providerId}-${subHex}${PLACEHOLDER_EMAIL_SUFFIX}`;
  const name = claims.name && claims.name.length > 0 ? claims.name : fallbackName;
  await db().insert(users).values({
    id,
    email,
    passwordHash: SENTINEL_PASSWORD_HASH,
    name,
    role: "guest",
    createdAt: now,
  });
  return id;
}

async function insertIdentity(
  userId: string,
  providerId: string,
  sub: string,
  display: string | null,
): Promise<void> {
  await db().insert(userIdentities).values({
    id: crypto.randomUUID(),
    userId,
    provider: providerId,
    providerUserId: sub,
    display,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
}

/**
 * callback 主流程。回傳 OAuthOutcome —— route 依 kind 設 cookie / redirect。
 * 所有錯誤都轉為帶機器可讀 error code 的 redirect(登入頁/帳號頁翻 i18n)。
 */
export async function completeOAuth(opts: CompleteOptions): Promise<OAuthOutcome> {
  const loginErr = (code: string): OAuthOutcome => ({
    kind: "redirect",
    location: `/login?error=${code}`,
  });
  const accountRedirect = (q: string): OAuthOutcome => ({
    kind: "redirect",
    location: `/admin/account?${q}`,
  });

  if (opts.error) return loginErr("oauth_denied");
  if (!opts.code || !opts.state) return loginErr("oauth_state");

  // 1) state 一次性取用。
  const payload = await consumeState(opts.state);
  if (!payload || payload.provider !== opts.providerId) return loginErr("oauth_state");

  const isLink = payload.mode === "link";
  const failLocation = isLink ? "/admin/account?error=oauth_failed" : "/login?error=oauth_failed";

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
    const claims = await verifyIdToken(token.id_token, jwks, {
      issuer: provider.loginProvider.issuer,
      clientId: provider.clientId,
      nonce: payload.nonce,
    });
    // 明確標記「未驗證」的 email 視同沒有 email(走 placeholder)—— 防止用未驗證
    // email 佔用/撞既有帳號的 email 檢查。缺 email_verified claim(如 LINE)不受影響。
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
    const existing = await db()
      .select({ id: userIdentities.id, userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, opts.providerId),
          eq(userIdentities.providerUserId, claims.sub),
        ),
      )
      .limit(1);
    const identity = existing[0];

    if (isLink) {
      if (!payload.userId) throw new OidcError("link_no_user");
      if (identity && identity.userId !== payload.userId) {
        return accountRedirect("error=identity_taken");
      }
      if (identity && identity.userId === payload.userId) {
        await upsertLastUsed(identity.id);
        return accountRedirect("linked=1");
      }
      await insertIdentity(payload.userId, opts.providerId, claims.sub, display);
      return accountRedirect("linked=1");
    }

    // mode=login
    if (identity) {
      await upsertLastUsed(identity.id);
      return { kind: "session", userId: identity.userId, location: safeNext(payload.next) };
    }

    // identity 不存在 → 註冊 policy。
    const policy = await getSetting<string>("core.auth.oauthRegistration", "guest");
    if (policy !== "guest") return loginErr("not_linked");

    // email 撞既有 user → 不自動綁(防接管)。
    if (claims.email) {
      const clash = await db()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, claims.email.toLowerCase()))
        .limit(1);
      if (clash.length > 0) return loginErr("email_exists");
    }

    const newUserId = await createGuestUser(
      opts.providerId,
      claims,
      provider.loginProvider.button.label,
    );
    await insertIdentity(newUserId, opts.providerId, claims.sub, display);
    return { kind: "session", userId: newUserId, location: safeNext(payload.next) };
  } catch {
    // 任何引擎錯誤(discovery/token/簽章/DB)→ 帶 oauth_failed 導回。訊息不外洩。
    return { kind: "redirect", location: failLocation };
  }
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
