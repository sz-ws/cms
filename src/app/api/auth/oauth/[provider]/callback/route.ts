import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  purgeExpiredSessions,
  sessionCookieOptions,
} from "@/lib/auth";

// spec-login-providers.md §5 callback:GET /api/auth/oauth/[provider]/callback
//   ?code&state(?error= → redirect /login?error=oauth_denied)
// 引擎(@/lib/oidc completeOAuth)做 state 取用 / token exchange / id_token 驗證 /
// 分支;回傳 OAuthOutcome —— 本 route 只負責:session 結果時建 session + 設 cookie,
// 之後(或錯誤時)導向引擎給的 location。所有錯誤皆為帶機器可讀 code 的 redirect。
//
// GET 外部導回,無 cookie/Origin 語意,故不做 assertSameOrigin(同 start;CSRF 由
// 一次性 state 防護)。workers pool 地雷:@/lib/oidc 於 handler 內 dynamic import。

function absolute(req: Request, path: string): string {
  return new URL(path, req.url).toString();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await ctx.params;
  const url = new URL(req.url);

  const { completeOAuth } = await import("@/lib/oidc");
  const outcome = await completeOAuth({
    providerId: provider,
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    req,
  });

  if (outcome.kind === "session") {
    await purgeExpiredSessions(outcome.userId);
    const token = await createSession(outcome.userId);
    const store = await cookies();
    store.set(SESSION_COOKIE, token, sessionCookieOptions());
  }
  return Response.redirect(absolute(req, outcome.location), 302);
}
