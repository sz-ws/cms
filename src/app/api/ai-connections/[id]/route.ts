import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { revokeGrant } from "@/lib/mcp/grants";

// DELETE /api/ai-connections/[id]:設定頁「AI 連線」上的中斷連線。admin + same-origin
// (cookie session 的 mutation,同 /api/tokens/[id])。
//
// 連線、它的授權碼與權杖在同一個 batch 裡刪掉 —— App 手上的權杖下一次呼叫就是 401,
// 不必等它過期。不存在的 id 也回 ok:按兩下或兩位管理員同時按,結果都是「已中斷」。

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const { id } = await ctx.params;
  if (!id || id.length > 100) return Response.json({ error: "invalid_input" }, { status: 400 });
  await revokeGrant(id);
  return Response.json({ ok: true });
}
