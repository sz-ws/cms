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
  return Response.json({ ok: true });
}
