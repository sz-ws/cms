import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { revokeApiToken } from "@/lib/api-token";

// DELETE /api/tokens/[id]:撤銷 token。admin + Origin 檢查(cookie session mutation)。
// 撤銷後該 raw token 立即 401(見 authenticateApiToken)。
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
  await revokeApiToken(id);
  return Response.json({ ok: true });
}
