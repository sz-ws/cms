import { hitRateLimit } from "@/lib/rate-limit";
import { declaredLengthExceeds, readBoundedText } from "@/lib/body-limit";
import {
  bearerChallenge,
  corsHeaders,
  disabledResponse,
  isMcpEnabled,
  mcpResourceUrl,
  preflight,
  resolveMcpOrigin,
} from "@/lib/mcp/site";
import { authenticateAccessToken, bearerToken } from "@/lib/mcp/grants";
import type { AgentToolCtx, AgentToolRegistry } from "@/ext/agent-tools";

// AI 連線的 MCP 端點(Streamable HTTP,無狀態 JSON 回應)。
//
//   POST /api/mcp   Authorization: Bearer <access token>   body: JSON-RPC 2.0(單則或一批)
//   GET / DELETE    405 —— 不開 SSE 串流、不發 session id,所以沒有要 GET 的東西。
//
// 這裡只做 HTTP 層:開關 → 權杖 → 限流 → body 上限 → 交給 @/ext/mcp-server。JSON-RPC 與
// tool 的規則全在那一檔(測試因此不必組出 HTTP 請求就能守住「write 只在有權限時執行」)。
//
// 不看 cookie、不做 same-origin:憑證就是 bearer(同 /api/content 的 API token)。沒有權杖
// 或權杖不對一律 401 + WWW-Authenticate 指向 resource metadata —— AI App 就是從這個 401
// 開始整個「登入並允許」的流程。
//
// workers pool 地雷同 /api/admin/agent/*:registry / services 的相依鏈經 loader → interpret
// → next/navigation,一律 handler 內 dynamic import。

const METHODS = "POST, OPTIONS";
/** 單一請求的 body 上限。tool 的參數很小;一批最多 50 則也遠低於此。 */
const MAX_BODY_BYTES = 256_000;
/** 每條連線每分鐘的請求數。一次對話會連呼叫好幾個 tool,額度比面板的 /execute 寬。 */
const RATE_LIMIT = { namespace: "mcp", limit: 120, windowMs: 60_000 };

function unauthorized(origin: string, hadToken: boolean): Response {
  return Response.json(
    {
      error: hadToken ? "invalid_token" : "unauthorized",
      error_description: "Connect this app from the site first: it signs you in and asks for your approval.",
    },
    {
      status: 401,
      headers: {
        ...corsHeaders(METHODS),
        "WWW-Authenticate": bearerChallenge(origin, hadToken ? "invalid_token" : undefined),
      },
    },
  );
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...corsHeaders(METHODS), Allow: METHODS } });
}

export function OPTIONS(): Response {
  return preflight(METHODS);
}

export function GET(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isMcpEnabled())) return disabledResponse(METHODS);
  const origin = await resolveMcpOrigin(req.url);
  const now = Date.now();

  const raw = bearerToken(req.headers.get("authorization"));
  const caller = raw ? await authenticateAccessToken(raw, now) : null;
  // 權杖只對這個站的 MCP 網址有效(RFC 8707)。站台網址改過,舊連線要重新連。
  if (!caller || caller.resource !== mcpResourceUrl(origin)) return unauthorized(origin, raw !== null);

  if (await hitRateLimit(caller.grantId, RATE_LIMIT)) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...corsHeaders(METHODS), "Retry-After": "60" } },
    );
  }

  // 2025-06-18 起 client 在初始化之後的請求帶這個標頭;帶了我們不認得的版本 → 400(規格)。
  const { MCP_PROTOCOL_VERSIONS, handleMcpBody } = await import("@/ext/mcp-server");
  const version = req.headers.get("mcp-protocol-version");
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return Response.json(
      { error: "unsupported_protocol_version", supported: MCP_PROTOCOL_VERSIONS },
      { status: 400, headers: corsHeaders(METHODS) },
    );
  }

  if (declaredLengthExceeds(req, MAX_BODY_BYTES)) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: corsHeaders(METHODS) });
  }
  const text = await readBoundedText(req, MAX_BODY_BYTES, "mcp");
  if (text === null) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: corsHeaders(METHODS) });
  }
  let body: unknown;
  let parsed = true;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    parsed = false;
  }

  const [{ buildAgentToolRegistry }, { createServices }, { getLocale }, { getPlainSetting }, { CORE_API_VERSION }] =
    await Promise.all([
      import("@/ext/agent-tools-runtime"),
      import("@/ext/services"),
      import("@/lib/i18n/server"),
      import("@/lib/settings"),
      import("@/ext/version"),
    ]);

  // 一個請求內 registry 與 services 各建一次(一批訊息可能連呼叫好幾次 tools/list)。
  let registry: Promise<AgentToolRegistry> | null = null;
  let toolCtx: Promise<AgentToolCtx> | null = null;
  const siteTitle = await getPlainSetting<unknown>("core.siteTitle", "");

  const outcome = await handleMcpBody(body, parsed, {
    canWrite: caller.scope === "write",
    app: caller.app,
    locale: await getLocale(),
    siteTitle: typeof siteTitle === "string" ? siteTitle.trim() : "",
    serverVersion: CORE_API_VERSION,
    registry: () => (registry ??= buildAgentToolRegistry()),
    toolCtx: () =>
      (toolCtx ??= createServices("core").then((services) => ({ user: caller.user, services }))),
  });

  if (outcome.status === 202) return new Response(null, { status: 202, headers: corsHeaders(METHODS) });
  return Response.json(outcome.body, { headers: { ...corsHeaders(METHODS), "Cache-Control": "no-store" } });
}
