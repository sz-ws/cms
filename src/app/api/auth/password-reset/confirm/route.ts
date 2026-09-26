import { cookies } from "next/headers";
import { z } from "zod";
import { getDB } from "@/lib/cf";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { getLocale } from "@/lib/i18n/server";
import { fireSignedIn } from "@/lib/signed-in";
import { afterResponse, confirmPasswordReset, notifyPasswordChanged } from "@/lib/password-reset";

// 1.56.0:POST /api/auth/password-reset/confirm { email, code, password }
// 驗證碼對了:換密碼、登出所有裝置(在 confirmPasswordReset)→ 在這裡登入 → auth:signed-in
// (method "reset",emailVerified true)→ 回應之後寄「密碼已變更」。回 { ok: true },
// client 自己導去 /api/auth/continue 依身分分流。

const MAX_BODY_BYTES = 4_000;

const bodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .email()
      .refine((value) => !isPlaceholderEmail(value)),
    code: z.string().trim().max(12),
    password: z.string().max(1_000),
  })
  .strict();

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

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "password-reset-confirm");
  if (!body.ok) {
    return body.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) {
    const onEmail = parsed.error.issues.some((issue) => issue.path[0] === "email");
    return Response.json({ error: onEmail ? "invalid_email" : "invalid_input" }, { status: 400 });
  }

  const result = await confirmPasswordReset(getDB(), { ...parsed.data, ip: clientIp(req) }, Date.now());
  if (!result.ok) {
    return Response.json(
      result.error === "code_wrong" ? { error: result.error, attemptsLeft: result.attemptsLeft } : { error: result.error },
      { status: result.status },
    );
  }

  const token = await createSession(result.userId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
  await fireSignedIn({ userId: result.userId, method: "reset", emailVerified: true });
  await afterResponse(notifyPasswordChanged(result.email, await getLocale()));
  return Response.json({ ok: true });
}
