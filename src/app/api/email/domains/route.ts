import { requireAuth, authErrorResponse } from "@/lib/auth";
import { listEmailDomains } from "@/lib/email";

export const dynamic = "force-dynamic";

// GET /api/email/domains — active email provider 帳號下的寄信網域。
// admin settings 的 from-address 後綴提示用(EmailDomainChips)。admin-only:
// 網域清單屬帳號資訊,不給 editor。GET 無狀態變更,不需 assertSameOrigin。
// domains: null = 沒提示可給(未設 key / provider 不支援 / 查詢失敗)。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const domains = await listEmailDomains();
  return Response.json({ domains });
}
