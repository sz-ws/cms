import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { getDB } from "@/lib/cf";

export const dynamic = "force-dynamic";

// L1 §3:assertSameOrigin + requireAuth() → 只能刪自己的。
// 若這是自己最後一把 passkey 也允許刪(密碼 recovery 仍在,不會自鎖)——
// 故不加「最後一把」防護,DELETE ... WHERE id=? AND user_id=? 即可。
// 找不到 / 非自己所有 → changes===0 → 404。
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireAuth();
    const { id } = await params;

    const res = await getDB()
      .prepare("DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2")
      .bind(id, user.id)
      .run();

    if ((res.meta?.changes ?? 0) === 0) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    const r = originErrorResponse(e) ?? authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
