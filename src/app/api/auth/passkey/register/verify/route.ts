import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { finishRegistration, PasskeyError } from "@/lib/passkey";

// L1 §3:assertSameOrigin + requireAuth() → finishRegistration → 201 { id, name }。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireAuth();
    const body = await req.json().catch(() => null);
    const created = await finishRegistration(user, req, body);
    return Response.json(created, { status: 201 });
  } catch (e) {
    const r = originErrorResponse(e) ?? authErrorResponse(e);
    if (r) return r;
    // SPEC-GAP: §3 未明訂 register verify 失敗碼(只定義 login verify → 401)。
    // 選最簡:註冊回應無法驗證 → 400 passkey_failed。
    if (e instanceof PasskeyError) {
      return Response.json({ error: "passkey_failed" }, { status: 400 });
    }
    throw e;
  }
}
