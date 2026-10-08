import { timingSafeEqualString } from "./security";

// 1.76.0:OAuth 的 state 綁在開始登入的那個瀏覽器上。
//
// state 只放在資料庫時,它證明的是「這個 callback 對得上某一次我們發起的登入」,不是「對得上這個
// 瀏覽器發起的登入」。有人可以在自己的瀏覽器開始登入、在對方那邊用自己的身分同意、停在 callback
// 之前,再把那個 callback 網址(他的 code、他的 state)拿給別人開:別人的瀏覽器就登入成他的帳號
// (login CSRF)。
//
// 做法:/start 在瀏覽器放一個 cookie,callback 先看這個瀏覽器有沒有它,有才往下做。
//
// 它擋的是「得靠別人的瀏覽器送出 callback」的人:他知道自己的 state,但沒辦法在別人的瀏覽器放 cookie。
// 擋不了「知道 state、在自己的瀏覽器送 callback」的人 —— 值只是 state 的雜湊,他算得出來。登入模式
// 這樣做只會登入成他自己;連結模式會把他的身分掛到別人的帳號上,所以那裡另外要求完成時登入著開始的
// 那個帳號(oidc.ts 的 completeOAuth)。
//
//   - 值是 state 的 SHA-256(base64url),不是 state 本身;比對用定時比較。
//   - 一次登入一個 cookie,名字帶雜湊的前 8 個字。兩個分頁各登入一次互不干擾;別人送來的 callback
//     只碰得到「它那個 state」的名字,弄不掉這個瀏覽器正在進行的那一次。
//   - HttpOnly、Secure、SameSite=Lax(對方用頂層 GET 把瀏覽器送回來,Lax 會帶,Strict 不會)、
//     Path 只到 OAuth 的 API、Max-Age 等於 state 那一列的壽命。
//   - 沒走完的會留到過期。同時最多留 MAX_OAUTH_FLOWS 個,多的先丟最舊的(值的後半是開始的時間,
//     只用來排新舊,不是驗證的一部分)。
//
// 這個檔只用到 ./security 的定時比較:route 可以靜態 import(@/lib/oidc 得在 handler 裡動態載入)。

/** state 那一列與綁定 cookie 的壽命。同一個數字:cookie 不會比 state 活得久。 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** 兩個端點(/api/auth/oauth/<id>/start、/callback)都在這底下;別的請求不會帶這些 cookie。 */
export const OAUTH_FLOW_COOKIE_PATH = "/api/auth/oauth";
/**
 * 同一個瀏覽器同時記得幾次還沒走完的登入。一個約 75 bytes,只有 OAuth 的兩個端點收得到。
 * 沒有上限的話,一直按登入(或被別的網頁一直帶去 /start)會把請求的 header 撐爆。
 */
export const MAX_OAUTH_FLOWS = 10;

const COOKIE_PREFIX = "oauth_flow_";
const NAME_HASH_CHARS = 8;
/** 引擎發的 state 是 32 bytes 的小寫 hex。不是這個樣子的不必算雜湊,也不必查表。 */
const STATE_RE = /^[0-9a-f]{64}$/;

export interface FlowCookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** next/headers 的 cookies() 裡用到的那一小部分(測試給假的)。 */
export interface FlowCookieStore {
  get(name: string): { value: string } | undefined;
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: FlowCookieOptions): unknown;
}

export function isOAuthState(state: string | null | undefined): state is string {
  return typeof state === "string" && STATE_RE.test(state);
}

/** SHA-256(state) 的 base64url,43 個字。 */
export async function oauthStateHash(state: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)));
  let bin = "";
  for (const byte of digest) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function oauthFlowCookieName(hash: string): string {
  return `${COOKIE_PREFIX}${hash.slice(0, NAME_HASH_CHARS)}`;
}

/** maxAge 0 = 請瀏覽器刪掉(Path 要跟設的時候一樣才刪得到)。 */
function cookieOptions(maxAge: number): FlowCookieOptions {
  return { httpOnly: true, secure: true, sameSite: "lax", path: OAUTH_FLOW_COOKIE_PATH, maxAge };
}

/** 值 = <雜湊>.<開始時間,36 進位的毫秒>。看不懂的、寫在未來的,都當成最舊。 */
function startedAt(value: string, now: number): number {
  const at = parseInt(value.split(".")[1] ?? "", 36);
  return Number.isFinite(at) && at <= now ? at : 0;
}

/** /start:記下這一次登入是這個瀏覽器開始的。 */
export async function bindOAuthFlow(store: FlowCookieStore, state: string, now = Date.now()): Promise<void> {
  const hash = await oauthStateHash(state);
  const name = oauthFlowCookieName(hash);
  const others = store.getAll().filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX) && cookie.name !== name);
  const surplus = others.length - (MAX_OAUTH_FLOWS - 1);
  if (surplus > 0) {
    const oldestFirst = [...others].sort((a, b) => startedAt(a.value, now) - startedAt(b.value, now));
    for (const stale of oldestFirst.slice(0, surplus)) store.set(stale.name, "", cookieOptions(0));
  }
  store.set(name, `${hash}.${now.toString(36)}`, cookieOptions(OAUTH_STATE_TTL_MS / 1000));
}

/**
 * callback:這個瀏覽器是不是開始這一次登入的那一個。
 * 有這一次的 cookie 就清掉(不管對不對、接下來成不成功),別的登入的 cookie 不碰。
 */
export async function takeOAuthFlow(store: FlowCookieStore, state: string | null): Promise<boolean> {
  if (!isOAuthState(state)) return false;
  const hash = await oauthStateHash(state);
  const name = oauthFlowCookieName(hash);
  const held = store.get(name);
  if (!held) return false;
  store.set(name, "", cookieOptions(0));
  return timingSafeEqualString(held.value.split(".")[0] ?? "", hash);
}
