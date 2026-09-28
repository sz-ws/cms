import { getPlainSetting } from "../settings";

// AI 連線的站台層:開關、網址、兩份探索文件(RFC 9728 / RFC 8414)、共用的回應形狀。
//
// ── 開關 ────────────────────────────────────────────────────────────────────
// core.mcp.enabled 預設關。關著的時候**每一個**入口(MCP、探索文件、登記、換權杖、
// 同意畫面)都回「沒有開放」,已連線的 App 也一律暫停 —— 連線資料不刪,重新打開就恢復。
// 讀的是 getPlainSetting:這幾個值都不是 secret,不必為了判斷 secret 把整個 extension
// runtime 載進來(探索文件是公開、會被頻繁探測的端點)。
//
// ── 網址從哪裡來 ────────────────────────────────────────────────────────────
// 與 lib/oidc.ts 的 resolveOrigin 同一條規則:core.siteUrl 是 https(本機開發允許 http 的
// loopback)就用它,否則用這次請求的 origin。所有對外宣告的網址(issuer、resource、
// 各端點)都由同一個 origin 組出來,後台設定頁顯示的 MCP 網址也是 —— App 拿到的
// 每一個網址才會彼此對得上(規格要求 client 比對 resource 與它連的網址)。

export const MCP_ENABLED_SETTING = "core.mcp.enabled";

/** MCP 端點的路徑。resource identifier = origin + 這個路徑。 */
export const MCP_PATH = "/api/mcp";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/api/oauth/token";
const REGISTER_PATH = "/api/oauth/register";
const REVOKE_PATH = "/api/oauth/revoke";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** 兩種權限。write 含 read。 */
export type McpScope = "read" | "write";
const MCP_SCOPES: readonly McpScope[] = ["read", "write"];

export async function isMcpEnabled(): Promise<boolean> {
  return (await getPlainSetting<unknown>(MCP_ENABLED_SETTING, false)) === true;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** core.siteUrl 可用就用它(見檔頭),否則 fallback(這次請求的 origin)。 */
export async function resolveMcpOrigin(fallback: string): Promise<string> {
  const site = await getPlainSetting<unknown>("core.siteUrl", "");
  if (typeof site === "string" && site.trim()) {
    try {
      const u = new URL(site.trim());
      if (u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname))) {
        return u.origin;
      }
    } catch {
      // 無效的 siteUrl:退回請求的 origin。
    }
  }
  return new URL(fallback).origin;
}

export function mcpResourceUrl(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

/**
 * RFC 8707 的 resource 參數 → 認得就回正規的 MCP 網址,認不得回 null。
 *
 * 收三種寫法:MCP 網址本身(有沒有結尾斜線都算)與站台 origin。後者是給「把整個站當成
 * resource」的 client —— 它們要的是同一個東西,拒絕只會讓連線莫名失敗。
 */
export function matchResource(value: string, origin: string): string | null {
  const canonical = mcpResourceUrl(origin);
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === canonical || trimmed === origin ? canonical : null;
}

/** RFC 9728:受保護資源的 metadata。 */
export function protectedResourceMetadata(origin: string, siteTitle: string): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    ...(siteTitle ? { resource_name: siteTitle } : {}),
  };
}

/** RFC 8414:授權伺服器的 metadata。issuer 就是站台 origin(沒有路徑)。 */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** 401 的 WWW-Authenticate(MCP 授權規格:指向 resource metadata)。 */
export function bearerChallenge(origin: string, error?: "invalid_token"): string {
  const parts = [`resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

// ---- 回應 ----

// 探索文件、登記、換權杖與 MCP 本身都只靠 bearer 或 PKCE,不看 cookie —— 開 CORS 不會讓
// 任何網站借用管理員的登入狀態,卻能讓跑在瀏覽器裡的 MCP client 連得上。同意畫面與
// 後台 API 走 cookie,**不**套用這組標頭。
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

export function corsHeaders(methods: string): Record<string, string> {
  return { ...CORS_HEADERS, "Access-Control-Allow-Methods": methods };
}

export function preflight(methods: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(methods) });
}

/**
 * OAuth 端點的 JSON 回應。Cache-Control: no-store 是 RFC 6749 §5.1 對權杖回應的要求;
 * 其餘 OAuth 回應一併照辦,錯誤回應也不該被任何中間層快取。
 */
export function oauthJson(
  body: unknown,
  status: number,
  methods: string,
  extra?: Record<string, string>,
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(methods),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...extra,
    },
  });
}

/** RFC 6749 §5.2 形狀的錯誤。description 是給開發者看的英文,不會出現在後台。 */
export function oauthError(
  error: string,
  description: string,
  status: number,
  methods: string,
  extra?: Record<string, string>,
): Response {
  return oauthJson({ error, error_description: description }, status, methods, extra);
}

/** 關著的時候每個入口的回答。404:對外而言這個功能不存在。 */
export function disabledResponse(methods: string): Response {
  return oauthError(
    "not_enabled",
    "AI connections are turned off for this site. An admin can turn them on in Settings.",
    404,
    methods,
  );
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}
