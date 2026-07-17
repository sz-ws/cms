import { requireAuth, AuthError } from "@/lib/auth";
import { hitRateLimit } from "@/lib/rate-limit";

// spec-login-providers.md §5 start:GET /api/auth/oauth/[provider]/start
//   ?mode=login|link&next=...
// - mode=link 先 requireAuth("guest")(任何已登入者可綁);payload 記 userId。
// - 產 state/nonce/PKCE、寫 oauth_states(TTL 10 分鐘),302 到 authorization_endpoint。
//
// 這是頂層瀏覽器導覽(location.href),非 cookie mutation,故不做 assertSameOrigin
// (CSRF 由一次性 state 防護);callback 亦然。
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

  const { beginOAuth } = await import("@/lib/oidc");
  const result = await beginOAuth({ providerId: provider, mode, userId, next, req });

  if ("error" in result) {
    const dest =
      mode === "link"
        ? `/admin/account?error=${result.error}`
        : `/login?error=${result.error}`;
    return Response.redirect(absolute(req, dest), 302);
  }
  return Response.redirect(result.location, 302);
}
