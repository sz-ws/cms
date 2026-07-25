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
import { readBoundedJsonObject } from "@/lib/body-limit";

// 這四個欄位再長也不會接近 16KB;訂這麼小就是不讓未驗證的請求有機會餵大 body。
const MAX_BODY_BYTES = 16_000;

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

  const body = await readBoundedJsonObject(req, MAX_BODY_BYTES, "setup");
  if (!body.ok) {
    return body.reason === "too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_input" }, { status: 400 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(body.value);
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const email = parsed.email.toLowerCase();

  // 便宜的存在性檢查,擺在 hashPassword **之前**。
  //
  // 這一關不是併發防線 —— 併發仍然由下面的 INSERT ... WHERE COUNT(*)=0 保證,
  // 那個不能拿掉。這一關擋的是另一件事:setup 完成之後,這個端點仍然公開,
  // 而原本的順序會先跑滿 6×100k PBKDF2 才發現「已經有人了」再回 403。
  // 於是任何人都能用一個極便宜的請求,換走 Worker 上一次昂貴的雜湊運算,
  // 想打多久打多久。先問一句 SELECT 1 就沒有這個放大倍率了。
  const existing = await getDB()
    .prepare(`SELECT 1 FROM users LIMIT 1`)
    .first<{ 1: number }>();
  if (existing) {
    return Response.json({ error: "already_setup" }, { status: 403 });
  }

  // 工作因子由平台上限與鏈式輪數決定,不是可設定值,所以這裡沒有「校準完成了嗎」
  // 的關卡。曾經有過:它要求先跑出 600k,而 Workers 永遠做不到,於是任何人都
  // 建不出第一個管理員。見 src/lib/password-work-factor.ts。
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
