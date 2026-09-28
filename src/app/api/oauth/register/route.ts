import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { clientIp, disabledResponse, isMcpEnabled, oauthError, oauthJson, preflight } from "@/lib/mcp/site";
import { parseRegistration, pruneAbandonedClients, registerClient } from "@/lib/mcp/clients";

// AI 連線:App 的動態登記(RFC 7591)。
//
//   POST /api/oauth/register   body: client metadata(JSON)
//   → 201 { client_id, client_secret?, redirect_uris, token_endpoint_auth_method, … }
//
// 公開、不需登入 —— MCP 授權規格要 App 能自己登記。登記本身不給任何權限:拿到 client_id
// 之後,仍要一位管理員登入、在同意畫面上按「允許」才會有連線。所以這裡防的是濫用
// (塞爆資料表),不是越權:每個 IP 十分鐘十次,body 16 KB,沒人允許過的登記一週後清掉。

const METHODS = "POST, OPTIONS";
const MAX_BODY_BYTES = 16_000;
const RATE_LIMIT = { namespace: "mcp-register", limit: 10, windowMs: 10 * 60_000 };

export function OPTIONS(): Response {
  return preflight(METHODS);
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  if (await hitRateLimit(clientIp(req), RATE_LIMIT)) {
    return oauthError("slow_down", "Too many registrations from this address. Try again later.", 429, METHODS, {
      "Retry-After": "600",
    });
  }

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "mcp-register");
  if (!body.ok) {
    return body.reason === "too_large"
      ? oauthError("invalid_client_metadata", "Client metadata is too large.", 413, METHODS)
      : oauthError("invalid_client_metadata", "The body must be a JSON object.", 400, METHODS);
  }
  const parsed = parseRegistration(body.value);
  if (!parsed.ok) return oauthError(parsed.error, parsed.description, 400, METHODS);

  const now = Date.now();
  await pruneAbandonedClients(now);
  const client = await registerClient(parsed.value, now);

  return oauthJson(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.issuedAt / 1000),
      ...(client.clientSecret ? { client_secret: client.clientSecret, client_secret_expires_at: 0 } : {}),
      ...(parsed.value.name ? { client_name: parsed.value.name } : {}),
      redirect_uris: parsed.value.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: parsed.value.authMethod,
    },
    201,
    METHODS,
  );
}
