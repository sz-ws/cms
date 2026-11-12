import { draftMode } from "next/headers";
import { destroySession } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
  await destroySession();
  // 2.0:登出也關掉草稿預覽(Next 的 draft mode cookie)。middleware 對每個帶著它的請求另外驗
  // session(src/lib/preview-access.ts),這裡是讓瀏覽器馬上丟掉它。
  (await draftMode()).disable();
  return Response.json({ ok: true });
}
