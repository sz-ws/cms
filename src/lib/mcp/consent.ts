import { z } from "zod";
import { redirectUriMatches, type McpClient } from "./clients";
import { isValidCodeChallenge, signTicket, verifyTicket, TICKET_TTL_MS } from "./crypto";
import { matchResource } from "./site";

// 授權請求(GET /oauth/authorize 的查詢字串)的驗證,與同意票的內容。純函式,
// 同意畫面(page)與按下按鈕的 POST 共用。
//
// ── 錯誤導向哪裡(RFC 6749 §4.1.2.1)────────────────────────────────────────
// client_id 或 redirect_uri 不對 → **絕不導回**,只在我們自己的頁面上說明:那個網址還沒
// 被證明屬於這個 App,導過去就是 open redirect。其餘參數不對 → 導回 App 的 redirect_uri,
// 帶 error 與原本的 state,讓 App 自己顯示錯誤。

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** 不能導回:在頁面上顯示。 */
  | { ok: false; kind: "page"; reason: "unknown_client" | "bad_redirect_uri" }
  /** 可以導回:帶著 error 回 App。 */
  | { ok: false; kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string };

type Query = Record<string, string | string[] | undefined>;

/** 同名參數出現兩次 = 不合法(RFC 6749 §3.1),回 undefined 讓呼叫端當成錯。 */
function single(query: Query, key: string): string | null | undefined {
  const value = query[key];
  if (value === undefined) return null;
  return Array.isArray(value) ? undefined : value;
}

const MAX_STATE_LENGTH = 1_000;

export function checkAuthorizeRequest(query: Query, client: McpClient | null, origin: string): AuthorizeCheck {
  if (!client) return { ok: false, kind: "page", reason: "unknown_client" };

  const rawRedirect = single(query, "redirect_uri");
  let redirectUri: string;
  if (rawRedirect === undefined) return { ok: false, kind: "page", reason: "bad_redirect_uri" };
  if (rawRedirect === null) {
    // 省略只在「只登記了一個」時成立(OAuth 2.1 §2.3.2 的寬容寫法);MCP 的 client 都會帶。
    if (client.redirectUris.length !== 1) return { ok: false, kind: "page", reason: "bad_redirect_uri" };
    redirectUri = client.redirectUris[0];
  } else {
    if (!redirectUriMatches(client.redirectUris, rawRedirect)) {
      return { ok: false, kind: "page", reason: "bad_redirect_uri" };
    }
    redirectUri = rawRedirect;
  }

  // 從這裡起 redirect_uri 已確認屬於這個 App,錯誤可以導回。
  const rawState = single(query, "state");
  const state = typeof rawState === "string" && rawState.length > 0 ? rawState.slice(0, MAX_STATE_LENGTH) : null;
  const fail = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    kind: "redirect",
    redirectUri,
    state,
    error,
    description,
  });

  if (rawState === undefined) return fail("invalid_request", "state must appear once.");
  const responseType = single(query, "response_type");
  if (responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const method = single(query, "code_challenge_method");
  const challenge = single(query, "code_challenge");
  if (method !== "S256" || !isValidCodeChallenge(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const rawResource = single(query, "resource");
  if (rawResource === undefined) return fail("invalid_target", "resource must appear once.");
  const resource = rawResource === null ? matchResource(origin, origin) : matchResource(rawResource, origin);
  if (!resource) return fail("invalid_target", "This server only issues tokens for its MCP endpoint.");

  return { ok: true, request: { clientId: client.id, redirectUri, codeChallenge: challenge, state, resource } };
}

/** 導回 App 的網址:保留 redirect_uri 自己的查詢字串,加上結果參數與 iss(RFC 9207)。 */
export function appRedirectUrl(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---- 同意票 ----

const ticketSchema = z
  .object({
    exp: z.number(),
    uid: z.string().min(1),
    cid: z.string().min(1),
    ru: z.string().min(1),
    cc: z.string().min(1),
    st: z.string().nullable(),
    res: z.string().min(1),
  })
  .strict();

export interface ConsentTicket extends AuthorizeRequest {
  userId: string;
}

/** 把驗過的授權請求簽成票(見 crypto.ts 的說明)。sessionSecret = session cookie 原值。 */
export function issueConsentTicket(
  request: AuthorizeRequest,
  userId: string,
  sessionSecret: string,
  now: number,
): Promise<string> {
  const payload = {
    exp: now + TICKET_TTL_MS,
    uid: userId,
    cid: request.clientId,
    ru: request.redirectUri,
    cc: request.codeChallenge,
    st: request.state,
    res: request.resource,
  };
  return signTicket(payload, sessionSecret);
}

export async function readConsentTicket(
  ticket: unknown,
  sessionSecret: string,
  now: number,
): Promise<ConsentTicket | null> {
  const raw = await verifyTicket(ticket, sessionSecret, now);
  if (!raw) return null;
  const parsed = ticketSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  return {
    userId: t.uid,
    clientId: t.cid,
    redirectUri: t.ru,
    codeChallenge: t.cc,
    state: t.st,
    resource: t.res,
  };
}

/** 同意畫面上「允許後會回到哪裡」:https 顯示主機名稱,其餘(本機、原生 App)顯示 scheme 或主機。 */
export function redirectDisplayHost(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return url.protocol.replace(/:$/, "");
  } catch {
    return redirectUri.slice(0, 60);
  }
}
