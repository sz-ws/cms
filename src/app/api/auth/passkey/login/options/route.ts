import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { startAuthentication } from "@/lib/passkey";

export const dynamic = "force-dynamic";

// L1 §3:assertSameOrigin(無 session 要求)→ startAuthentication。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const options = await startAuthentication(req);
    return Response.json(options);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
