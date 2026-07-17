import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { runDueJobs } from "@/lib/jobs";

// POST /api/jobs/run:手動催發 core jobs（見 src/lib/jobs.ts）。
// admin only + same-origin(mutation:改動 D1 內容狀態,走 CSRF 防線)。
// 回傳每支任務的逐項結果 { id, ok, processed?, detail? }。
export async function POST(req: Request): Promise<Response> {
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

  const now = Date.now();
  const jobs = await runDueJobs(now);
  return Response.json({ ok: true, ranAt: now, jobs });
}
