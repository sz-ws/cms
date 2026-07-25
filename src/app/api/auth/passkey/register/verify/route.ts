import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { finishRegistration, PasskeyError } from "@/lib/passkey";
import { readBoundedJsonObject } from "@/lib/body-limit";

// WebAuthn 的 attestation/assertion 遠小於此;未驗證入口一律封頂。
const MAX_BODY_BYTES = 64_000;

// L1 §3:assertSameOrigin + requireAuth() → finishRegistration → 201 { id, name }。
export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const user = await requireAuth();
    const parsedBody = await readBoundedJsonObject(req, MAX_BODY_BYTES, "passkey-register");
    const body = parsedBody.ok ? parsedBody.value : null;
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
