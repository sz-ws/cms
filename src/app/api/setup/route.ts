import { cookies } from "next/headers";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDB } from "@/lib/cf";
import {
  SESSION_COOKIE,
  createSession,
  hashPassword,
  sessionCookieOptions,
} from "@/lib/auth";
import { setSettings } from "@/lib/settings";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  siteTitle: z.string().min(1),
});

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
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const email = parsed.email.toLowerCase();
  const passwordHash = await hashPassword(parsed.password);
  const id = nanoid();
  const now = Date.now();

  // 04 §5:建立 admin 這一步原子防併發。Drizzle insert builder 不支援
  // INSERT ... SELECT ... WHERE,改用 raw prepare;結果取 meta.changes。
  const res = await getDB()
    .prepare(
      `INSERT INTO users (id, email, password_hash, name, role, created_at)
       SELECT ?1, ?2, ?3, ?4, 'admin', ?5
       WHERE (SELECT COUNT(*) FROM users) = 0`,
    )
    .bind(id, email, passwordHash, parsed.name, now)
    .run();

  if (res.meta.changes === 0) {
    // 已有使用者(併發輸家或重複 setup)→ 403
    return Response.json({ error: "already_setup" }, { status: 403 });
  }

  // 後續步驟失敗的恢復 = 用剛設的密碼去 /login(04 §5),不需特殊處理。
  await setSettings({ "core.siteTitle": parsed.siteTitle });

  const token = await createSession(id);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());

  return Response.json({ ok: true });
}
