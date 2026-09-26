import { z } from "zod";
import { getDB } from "@/lib/cf";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { getLocale } from "@/lib/i18n/server";
import { emailReady } from "@/lib/email";
import { requestPasswordReset } from "@/lib/password-reset";

// 1.56.0:POST /api/auth/password-reset { email } —— 忘記密碼,寄一組驗證碼。
// 有沒有這個帳號,回應都是 { ok: true, resendIn }(規則見 src/lib/password-reset.ts)。
// 未驗證入口:same-origin、body 封頂,限速在 requestPasswordReset。

const MAX_BODY_BYTES = 2_000;

const bodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .email()
      .refine((value) => !isPlaceholderEmail(value)),
  })
  .strict();

// 同 /api/auth/login:本機 next dev 沒有 CF-Connecting-IP。
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

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "password-reset");
  if (!body.ok) {
    return body.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_email" }, { status: 400 });
  if (!(await emailReady())) return Response.json({ error: "email_unavailable" }, { status: 503 });

  const result = await requestPasswordReset(
    getDB(),
    { email: parsed.data.email, ip: clientIp(req), locale: await getLocale() },
    Date.now(),
  );
  if (result.ok) return Response.json({ ok: true, resendIn: result.resendIn });
  return Response.json(
    result.error === "cooldown" ? { error: result.error, retryIn: result.retryIn } : { error: result.error },
    { status: result.status },
  );
}
