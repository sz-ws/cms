import { cookies } from "next/headers";
import { requireAuth, AuthError } from "@/lib/auth";
import { bindOAuthFlow } from "@/lib/oauth-flow-cookie";
import { hitRateLimit } from "@/lib/rate-limit";

// spec-login-providers.md §5 start:GET /api/auth/oauth/[provider]/start
//   ?mode=login|link&next=...&back=...(1.54.0:失敗時回的站內路徑)
// - mode=link 先 requireAuth("guest")(任何已登入者可綁);payload 記 userId。別的網站來的(Sec-Fetch-Site:
//   cross-site)不開始,見下面。
// - 產 state/nonce/PKCE、寫 oauth_states(TTL 10 分鐘),302 到 authorization_endpoint。
// - 1.76.0:同一個回應在瀏覽器放一個 cookie(state 的雜湊),callback 只認帶著它的瀏覽器
//   (src/lib/oauth-flow-cookie.ts)。
//
// 這是頂層瀏覽器導覽(location.href),非 cookie mutation,故不做 assertSameOrigin。
// CSRF 由兩樣東西一起擋:一次性的 state(對得上我們發起的某一次登入),加上面那個 cookie
// (對得上「這個瀏覽器」發起的那一次)。只有 state 的時候,別人的 callback 網址拿來就能用。
//
// workers pool 地雷:@/lib/oidc 的相依鏈(settings → 動態 import loader)雖非
// top-level 靜態 next/navigation,仍照 ai/generate/stream 慣例在 handler 內
// dynamic import,route 本身零 loader/services 靜態依賴。

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}

function absolute(req: Request, path: string): string {
  return new URL(path, req.url).toString();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "link" ? "link" : "login";
  const next = url.searchParams.get("next");
  // 1.54.0:失敗時回哪一頁(前台會員元件帶自己的路徑);沒帶就是後台登入頁。
  const back = url.searchParams.get("back");

  // 1.76.0:連結模式要從站內開始。連結是把一個身分掛到「登入著的這個帳號」上;這條路是 GET,別的網站放一個連結或
  // 一次轉址,就能在登入著的人的瀏覽器裡替他開始一次他沒有要求的連結(state 與 cookie 都會照給)。瀏覽器明講這個
  // 請求是別的網站來的(Sec-Fetch-Site: cross-site)就不開始:什麼都不記(不占下面的額度),送回帳號頁,那裡說
  // 要在這裡按「連結」。沒有這個 header 的(舊瀏覽器)照舊。登入模式不看:從別的網站連過來登入是正常的。
  if (mode === "link" && req.headers.get("sec-fetch-site") === "cross-site") {
    return Response.redirect(absolute(req, "/admin/account?error=oauth_browser"), 302);
  }

  // rate limit:防 state 表灌爆(開新 namespace,keyed by IP)。
  if (
    await hitRateLimit(clientIp(req), {
      namespace: "oauth-start",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  // mode=link 需已登入(guest 及以上)。未登入 → 導回登入頁。
  let userId: string | undefined;
  if (mode === "link") {
    try {
      const user = await requireAuth("guest");
      userId = user.id;
    } catch (e) {
      if (e instanceof AuthError) {
        return Response.redirect(absolute(req, "/login"), 302);
      }
      throw e;
    }
  }

  const { beginOAuth, loginErrorLocation } = await import("@/lib/oidc");
  const result = await beginOAuth({ providerId: provider, mode, userId, next, back, req });

  if ("error" in result) {
    const dest =
      mode === "link"
        ? `/admin/account?error=${result.error}`
        : loginErrorLocation(result.error, back);
    return Response.redirect(absolute(req, dest), 302);
  }
  // 記下這一次登入是這個瀏覽器開始的(cookies() 設的值會跟著下面的 302 一起送出)。
  await bindOAuthFlow(await cookies(), result.state);
  return Response.redirect(result.location, 302);
}
