import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  getSessionUser,
  purgeExpiredSessions,
  sessionCookieOptions,
} from "@/lib/auth";
import { takeOAuthFlow } from "@/lib/oauth-flow-cookie";
import { fireSignedIn } from "@/lib/signed-in";

// spec-login-providers.md §5 callback:GET /api/auth/oauth/[provider]/callback
//   ?code&state(?error= → redirect /login?error=oauth_denied)
// 引擎(@/lib/oidc completeOAuth)做 state 取用 / token exchange / id_token 驗證 /
// 分支;回傳 OAuthOutcome —— 本 route 只負責:session 結果時建 session + 設 cookie,
// 之後(或錯誤時)導向引擎給的 location。所有錯誤皆為帶機器可讀 code 的 redirect。
//
// GET 外部導回,沒有 Origin 可以比,故不做 assertSameOrigin(同 start)。CSRF 靠兩樣:一次性的
// state,加上 1.76.0 起 /start 放在瀏覽器的 cookie(src/lib/oauth-flow-cookie.ts)。這個瀏覽器
// 沒帶著這一次登入的 cookie,就不是它開始的:不呼叫 completeOAuth、不建 session、state 留著,
// 把人送回開始的那一頁請他再登入一次(引擎的 refuseUnboundCallback)。手機上對方的 App 把人送回
// 另一個瀏覽器時就會走到這裡,所以那是一句做法,不是警告。
// workers pool 地雷:@/lib/oidc 於 handler 內 dynamic import。

function absolute(req: Request, path: string): string {
  return new URL(path, req.url).toString();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // 先看是不是開始登入的那個瀏覽器。這一次的 cookie 在這裡就清掉,接下來成不成功都一樣。
  const store = await cookies();
  const sameBrowser = await takeOAuthFlow(store, state);

  const { completeOAuth, refuseUnboundCallback } = await import("@/lib/oidc");
  const outcome = sameBrowser
    ? await completeOAuth({
        providerId: provider,
        code: url.searchParams.get("code"),
        state,
        error,
        req,
        // 連結模式才會問:完成連結的要是開始的那個帳號。
        sessionUserId: async () => (await getSessionUser())?.id ?? null,
      })
    : await refuseUnboundCallback({ providerId: provider, state, error });

  if (outcome.kind === "session") {
    await purgeExpiredSessions(outcome.userId);
    const token = await createSession(outcome.userId);
    store.set(SESSION_COOKIE, token, sessionCookieOptions());
    await fireSignedIn({
      userId: outcome.userId,
      method: "oauth",
      provider,
      emailVerified: outcome.emailVerified,
    });
  }
  return Response.redirect(absolute(req, outcome.location), 302);
}
