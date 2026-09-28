import { hitRateLimit } from "@/lib/rate-limit";
import {
  clientIp,
  disabledResponse,
  isMcpEnabled,
  matchResource,
  oauthError,
  oauthJson,
  preflight,
  resolveMcpOrigin,
} from "@/lib/mcp/site";
import { clientSecretOk, getClient } from "@/lib/mcp/clients";
import { redeemCode, refreshGrant } from "@/lib/mcp/grants";
import { parseTokenRequest } from "@/lib/mcp/token-request";

// AI 連線:換權杖(OAuth 2.1 token endpoint)。
//
//   POST /api/oauth/token   form: grant_type=authorization_code | refresh_token
//
// 兩種 grant:
//   * authorization_code —— 碼一次性、5 分鐘;client_id、redirect_uri、PKCE verifier 都要
//     對上發碼時的那一次授權(規則在 lib/mcp/grants.ts 的 redeemCode)。
//   * refresh_token —— 每用一次換一把新的(rotation),舊的當場失效。
// 兩條路最後都會再確認「允許這條連線的人現在還是管理員」,不是就拒絕。
//
// 不看 cookie、不做 same-origin:這是 App 的伺服器在呼叫,憑證是碼 + verifier / refresh
// token(+ confidential client 的 secret)。錯誤的形狀照 RFC 6749 §5.2。

const METHODS = "POST, OPTIONS";
const MAX_BODY_BYTES = 16_000;
/** 每個 IP 每分鐘。正常使用一小時才換一次,這個額度只擋猜碼與失控的迴圈。 */
const RATE_LIMIT = { namespace: "mcp-token", limit: 30, windowMs: 60_000 };

export function OPTIONS(): Response {
  return preflight(METHODS);
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  if (await hitRateLimit(clientIp(req), RATE_LIMIT)) {
    return oauthError("slow_down", "Too many token requests. Try again in a minute.", 429, METHODS, {
      "Retry-After": "60",
    });
  }

  const parsed = await parseTokenRequest(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return oauthError("invalid_request", "The request body could not be read.", parsed.reason === "too_large" ? 413 : 400, METHODS);
  }
  const { params } = parsed;

  const client = await getClient(parsed.clientId);
  if (!client || !(await clientSecretOk(client, parsed.clientSecret))) {
    return oauthError("invalid_client", "Unknown client or wrong client credentials.", 401, METHODS);
  }

  const origin = await resolveMcpOrigin(req.url);
  let resource: string | null = null;
  if (params.resource !== undefined) {
    resource = matchResource(params.resource, origin);
    if (!resource) return oauthError("invalid_target", "This server only issues tokens for its MCP endpoint.", 400, METHODS);
  }

  const now = Date.now();
  const grantType = params.grant_type;
  let result;
  if (grantType === "authorization_code") {
    if (!params.code) return oauthError("invalid_request", "code is required.", 400, METHODS);
    result = await redeemCode(
      {
        code: params.code,
        clientId: client.id,
        redirectUri: params.redirect_uri ?? null,
        codeVerifier: params.code_verifier,
        resource,
      },
      now,
    );
  } else if (grantType === "refresh_token") {
    if (!params.refresh_token) return oauthError("invalid_request", "refresh_token is required.", 400, METHODS);
    result = await refreshGrant({ refreshToken: params.refresh_token, clientId: client.id, resource }, now);
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.", 400, METHODS);
  }

  if (!result.ok) return oauthError(result.error, result.description, 400, METHODS);
  return oauthJson(result.tokens, 200, METHODS);
}
