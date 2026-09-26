import { cookies } from "next/headers";
import { z } from "zod";
import {
  AuthError,
  SESSION_COOKIE,
  createSession,
  purgeExpiredSessions,
  requireAuth,
  sessionCookieOptions,
} from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { fireSignedIn } from "@/lib/signed-in";

// 1.54.0:POST /api/auth/firebase/[provider] { idToken, mode?, next? }
// 瀏覽器用 Firebase SDK 登入後把 ID token 交過來(見 src/lib/firebase-login.ts)。
//   - 成功登入:建 session、設 cookie,回 { location }(client 自己換頁)。
//   - mode=link:要已登入(帳號頁),綁上後回 { location: "/admin/account?linked=1" }。
//   - 失敗:{ error: <code> },由按鈕在原地顯示。
// 這是 cookie mutation,所以要 same-origin —— 也就是外站沒辦法用它自己的 token 讓訪客
// 登入成別人的帳號(login CSRF)。workers pool 地雷:@/lib/firebase-login 在 handler 內
// dynamic import(同 oauth start/callback)。

const MAX_BODY_BYTES = 8_000; // Firebase ID token 約 1 KB

const bodySchema = z.object({
  idToken: z.string().min(20).max(6000),
  mode: z.enum(["login", "link"]).optional(),
  next: z.string().max(2000).optional(),
});

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  if (
    await hitRateLimit(clientIp(req), {
      namespace: "firebase-login",
      limit: 30,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "firebase-login");
  if (!body.ok) {
    return body.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
  const mode = parsed.data.mode ?? "login";

  let userId: string | undefined;
  if (mode === "link") {
    try {
      userId = (await requireAuth("guest")).id;
    } catch (e) {
      if (e instanceof AuthError) return Response.json({ error: "unauthorized" }, { status: 401 });
      throw e;
    }
  }

  const { provider } = await ctx.params;
  const { completeFirebaseLogin } = await import("@/lib/firebase-login");
  const outcome = await completeFirebaseLogin({
    providerId: provider,
    idToken: parsed.data.idToken,
    mode,
    userId,
    next: parsed.data.next,
  });

  if (outcome.kind === "error") return Response.json({ error: outcome.code }, { status: 400 });
  if (outcome.kind === "linked") return Response.json({ location: "/admin/account?linked=1" });

  await purgeExpiredSessions(outcome.userId);
  const token = await createSession(outcome.userId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
  await fireSignedIn({
    userId: outcome.userId,
    method: "firebase",
    provider,
    emailVerified: outcome.emailVerified,
  });
  return Response.json({ location: outcome.location });
}
