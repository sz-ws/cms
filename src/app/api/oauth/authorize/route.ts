import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, getSessionAccess } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { isMcpEnabled, resolveMcpOrigin } from "@/lib/mcp/site";
import { getClient, redirectUriMatches } from "@/lib/mcp/clients";
import { approveGrant, connectPolicy } from "@/lib/mcp/grants";
import { appRedirectUrl, readConsentTicket } from "@/lib/mcp/consent";

// AI 連線:同意畫面(/oauth/authorize)上按下「允許」或「拒絕」之後的唯一入口。
//
//   POST /api/oauth/authorize   session cookie + same-origin
//   body: { ticket, decision: "approve" | "deny", access: "read" | "write" }
//   → { redirect }   前端導到這個網址(回到 App,帶著授權碼或 access_denied)
//
// 三道 CSRF / 竄改防線,每一道單獨都擋得住跨站送出:
//   1. same-origin(Origin 標頭);
//   2. session cookie 是 SameSite=Lax,跨站 POST 根本不會帶;
//   3. 同意票用這個 session 的 cookie 原值簽章(lib/mcp/crypto.ts)—— 而且票裡已經寫死
//      App、回呼網址、PKCE challenge,這裡**不收**任何授權參數,按下去生效的就是畫面上
//      那一個。
// 身分在這裡重新確認一次(connectPolicy):畫面打開到按下按鈕之間,權限可能已被改掉。
//
// 回 JSON 而不是 302:瀏覽器端用 location.assign 導過去。導向是導航、不是表單送出,
// CSP 的 form-action 'self' 不會把回到 App(外站)的那一步記成違規。

const MAX_BODY_BYTES = 16_000;
const RATE_LIMIT = { namespace: "mcp-consent", limit: 20, windowMs: 60_000 };

const bodySchema = z
  .object({
    ticket: z.string().min(1).max(8_000),
    decision: z.enum(["approve", "deny"]),
    access: z.enum(["read", "write"]),
  })
  .strict();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
  if (!(await isMcpEnabled())) return json({ error: "not_enabled" }, 404);

  const session = await getSessionAccess();
  if (!session) return json({ error: "unauthorized" }, 401);
  const policy = connectPolicy(session.user);
  if (!policy.connect) return json({ error: "forbidden" }, 403);

  if (await hitRateLimit(session.user.id, RATE_LIMIT)) return json({ error: "rate_limited" }, 429);

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "mcp-consent");
  if (!body.ok) return json({ error: "invalid_input" }, body.reason === "too_large" ? 413 : 400);
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return json({ error: "invalid_input" }, 400);

  const now = Date.now();
  const sessionSecret = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const ticket = await readConsentTicket(parsed.data.ticket, sessionSecret, now);
  if (!ticket || ticket.userId !== session.user.id) return json({ error: "expired" }, 400);

  // App 的登記可能在畫面打開之後被清掉(一週沒人允許的登記)—— 票裡的回呼網址仍要對得上現在的登記。
  const client = await getClient(ticket.clientId);
  if (!client || !redirectUriMatches(client.redirectUris, ticket.redirectUri)) {
    return json({ error: "unknown_client" }, 400);
  }

  const iss = await resolveMcpOrigin(req.url);
  if (parsed.data.decision === "deny") {
    return json({
      redirect: appRedirectUrl(ticket.redirectUri, { error: "access_denied", state: ticket.state, iss }),
    });
  }

  const code = await approveGrant(
    {
      clientId: client.id,
      userId: session.user.id,
      // 要「可以修改」但這個人不能給 → 只給查看(畫面本來就不會出現那個選項)。
      scope: parsed.data.access === "write" && policy.write ? "write" : "read",
      resource: ticket.resource,
      redirectUri: ticket.redirectUri,
      codeChallenge: ticket.codeChallenge,
    },
    now,
  );
  return json({ redirect: appRedirectUrl(ticket.redirectUri, { code, state: ticket.state, iss }) });
}
