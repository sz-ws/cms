import { base64url, hashToken } from "../api-token";
import { timingSafeEqualString } from "../security";

// AI 連線(MCP 授權)用到的密碼學小工具。全部純函式(只用 Web Crypto),路由與測試共用。
//
// 產生與雜湊沿用 api-token.ts 的手法:隨機 32 bytes → base64url;D1 只存 SHA-256 hex。
// 使用者送來的值一律只拿「雜湊」去查表(相等查詢,攻擊者控制不了雜湊的前綴),而在 JS
// 裡直接比對兩個祕密的地方(PKCE、client secret、同意票的簽章)一律 timingSafeEqualString。

export { hashToken };

/** 權杖、碼、client id/secret 的前綴。看得出是什麼東西,也讓祕密掃描器認得出來。 */
export const TOKEN_PREFIX = {
  access: "mcp_at_",
  refresh: "mcp_rt_",
  code: "mcp_ac_",
  client: "mcp_ci_",
  secret: "mcp_cs_",
} as const;

function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(len)));
}

/** 前綴 + 32 bytes 隨機值(256 bits)。client id 不是祕密,16 bytes 就夠。 */
export function randomToken(prefix: string, bytes = 32): string {
  return prefix + base64url(randomBytes(bytes));
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

// ---- PKCE(RFC 7636,只收 S256)----

/** code_verifier:43–128 個 unreserved 字元(RFC 7636 §4.1)。 */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** S256 的 code_challenge:SHA-256 的 32 bytes → base64url 無 padding,固定 43 字元。 */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_RE.test(value);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return base64url(new Uint8Array(digest));
}

/** verifier 格式不對直接 false —— 不讓任意長度的字串進 SHA-256。 */
export async function verifyPkce(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  return timingSafeEqualString(await pkceChallenge(verifier), challenge);
}

// ---- 同意票(consent ticket)----
//
// 同意畫面把「這一次授權請求的全部參數」簽成一張票,隨按鈕送回 POST /api/oauth/authorize。
// 兩個用途,一張票同時滿足:
//   1. CSRF:簽章金鑰是這位管理員的 session cookie 原值(httpOnly,別的網站讀不到;D1 只存
//      它的雜湊,資料庫外洩也算不出來)。別人偽造不出一張對得上這個 session 的票。
//   2. 完整性:按下「允許」時生效的,正是畫面上顯示的那個 App、那個回呼網址 —— POST 不再
//      接受任何可以被改動的授權參數。
// 不需要新的表或新的 env 祕密;票 10 分鐘過期,session 一登出就再也對不上。

const TICKET_DOMAIN = "mcp-consent/v1.";
export const TICKET_TTL_MS = 10 * 60 * 1000;

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, utf8(TICKET_DOMAIN + message));
  return base64url(new Uint8Array(mac));
}

function encodeJson(value: unknown): string {
  return base64url(utf8(JSON.stringify(value)));
}

function decodeJson(raw: string): unknown {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** payload → `<base64url(JSON)>.<base64url(HMAC)>`。payload 裡要自帶 exp(epoch ms)。 */
export async function signTicket(payload: { exp: number }, key: string): Promise<string> {
  // 空金鑰 = 沒有 session cookie:簽出來的票誰都算得出來,寧可當場失敗。
  if (!key) throw new Error("[mcp] consent ticket needs the session secret");
  const body = encodeJson(payload);
  return `${body}.${await hmac(key, body)}`;
}

/**
 * 驗票:簽章(constant-time)→ 解 JSON → exp。任何一步不對都回 null,不 throw ——
 * 票是從瀏覽器來的字串。回傳的是**未驗形狀**的物件,呼叫端自己再過 zod。
 */
export async function verifyTicket(
  ticket: unknown,
  key: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (typeof ticket !== "string" || ticket.length > 8_000 || !key) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const mac = ticket.slice(dot + 1);
  if (!timingSafeEqualString(await hmac(key, body), mac)) return null;
  let payload: unknown;
  try {
    payload = decodeJson(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp <= now) return null;
  return payload as Record<string, unknown>;
}
