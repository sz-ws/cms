import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  purgeExpiredSessions,
  sessionCookieOptions,
} from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { finishAuthentication } from "@/lib/passkey";

// 同 login route:本地 next dev 無 CF-Connecting-IP,fallback "local"。
function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}

// L1 §3:assertSameOrigin + rate limit(key pk:<ip>,同 login 的 15min/10 次)
// → finishAuthentication → createSession → set cookie → { ok: true }。
// 任何 passkey 失敗一律 401 { error: "passkey_failed" }(消除 oracle)。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  // rate limit(記一次 + 檢查;第 11 次 → 429)。
  const limited = await hitRateLimit(clientIp(req), {
    namespace: "pk",
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => null);
    const user = await finishAuthentication(req, body);

    await purgeExpiredSessions(user.id);
    const token = await createSession(user.id);
    const store = await cookies();
    store.set(SESSION_COOKIE, token, sessionCookieOptions());

    return Response.json({ ok: true });
  } catch {
    // 任何失敗(未知 credential / 過期 challenge / 驗證失敗)一律 401。
    return Response.json({ error: "passkey_failed" }, { status: 401 });
  }
}
