import { hitRateLimit } from "@/lib/rate-limit";
import { clientIp, disabledResponse, isMcpEnabled, oauthError, oauthJson, preflight } from "@/lib/mcp/site";
import { clientSecretOk, getClient } from "@/lib/mcp/clients";
import { revokeByToken } from "@/lib/mcp/grants";
import { parseTokenRequest } from "@/lib/mcp/token-request";

// AI 連線:App 自己要求撤銷權杖(RFC 7009)。使用者在 App 那邊中斷連線時,App 會呼叫這裡;
// 送的是 refresh token 就結束整條連線(設定頁的清單上也跟著消失)。
//
//   POST /api/oauth/revoke   form: token, token_type_hint?, client_id(+ secret)
//
// 規格要求:權杖不存在、不是這個 App 的,也一律 200 —— 不透露任何權杖的存在與否。

const METHODS = "POST, OPTIONS";
const MAX_BODY_BYTES = 8_000;
const RATE_LIMIT = { namespace: "mcp-revoke", limit: 30, windowMs: 60_000 };

export function OPTIONS(): Response {
  return preflight(METHODS);
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  if (await hitRateLimit(clientIp(req), RATE_LIMIT)) {
    return oauthError("slow_down", "Too many requests. Try again in a minute.", 429, METHODS, { "Retry-After": "60" });
  }
  const parsed = await parseTokenRequest(req, MAX_BODY_BYTES);
  if (!parsed.ok) return oauthError("invalid_request", "The request body could not be read.", 400, METHODS);
  const client = await getClient(parsed.clientId);
  if (!client || !(await clientSecretOk(client, parsed.clientSecret))) {
    return oauthError("invalid_client", "Unknown client or wrong client credentials.", 401, METHODS);
  }
  const token = parsed.params.token;
  if (!token) return oauthError("invalid_request", "token is required.", 400, METHODS);
  await revokeByToken(token, client.id);
  return oauthJson({}, 200, METHODS);
}
