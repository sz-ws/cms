import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { startRegistration } from "@/lib/passkey";

// L1 §3:assertSameOrigin + requireAuth() → startRegistration。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireAuth();
    const options = await startRegistration(user, req);
    return Response.json(options);
  } catch (e) {
    const r = originErrorResponse(e) ?? authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
