import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import {
  SESSION_COOKIE,
  createSession,
  getActivePasswordHashingProfile,
  purgeExpiredSessions,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import {
  clearLoginFailures,
  isRateLimited,
  recordLoginFailure,
} from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// SPEC-GAP: 04 §5 用 `CF-Connecting-IP` 作為 rate-limit 的 ip key。本地
// `next dev` 無此 header,fallback 到 "local" 讓 email key 仍生效(email 才是驗收測的 key)。
function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const email = parsed.email.toLowerCase();
  const ip = clientIp(req);

  // rate limit 檢查(先於任何昂貴運算)
  if (await isRateLimited(ip, email)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const rows = await db()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = rows[0];

  // dummy 與新寫入 hash 從同一個校準 profile 取 iterations，消除帳號列舉 oracle。
  const profile = await getActivePasswordHashingProfile();
  const ok = await verifyPassword(
    parsed.password,
    user ? user.passwordHash : profile.dummyHash,
  );

  if (!user || !ok) {
    await recordLoginFailure(ip, email);
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  // 成功:清失敗計數、清過期 session、建 session、設 cookie
  await clearLoginFailures(email);
  await purgeExpiredSessions(user.id);
  const token = await createSession(user.id);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());

  return Response.json({ ok: true });
}
