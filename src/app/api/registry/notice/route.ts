import { z } from "zod";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireAuth, authErrorResponse, isFullAdmin } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import {
  lookupNotice,
  markNoticeSeen,
  noticeSources,
  refreshStaleNotices,
} from "@/lib/registry-notice-store";

// 1.56.0:上新通知。後台殼層(components/admin/RegistryNoticeDialog.tsx)在管理員打開後台時
// 問一次 GET;彈窗關掉(任何方式)時 POST 記下看過。
//
// GET  → { notice: PickedNotice | null }
//   只給預設的管理員(editor、guest、自訂角色永遠是 null)。沒有任何來源打開通知時,
//   連資料庫都不碰,更不會對外連線。有來源的快取超過 12 小時,就在 waitUntil 裡更新
//   (回應不等它),這次先用舊快取挑。
// POST { source, id } → 204

const seenSchema = z
  .object({
    source: z.string().min(1).max(2048),
    id: z.string().min(1).max(64),
  })
  .strict();

async function fullAdminId(): Promise<string | null | Response> {
  try {
    const user = await requireAuth("admin");
    return isFullAdmin(user) ? user.id : null;
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

/** 回應之後才做;拿不到 Cloudflare context(非 Worker 環境)就直接等它做完。 */
async function afterResponse(task: Promise<void>): Promise<void> {
  try {
    getCloudflareContext().ctx.waitUntil(task);
  } catch {
    await task;
  }
}

export async function GET(): Promise<Response> {
  const userId = await fullAdminId();
  if (userId instanceof Response) return userId;
  if (userId === null) return Response.json({ notice: null });

  const sources = await noticeSources();
  if (sources.length === 0) return Response.json({ notice: null });

  const now = Date.now();
  const { notice, stale } = await lookupNotice(userId, sources, now);
  if (stale.length > 0) await afterResponse(refreshStaleNotices(stale, now));
  return Response.json({ notice });
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const userId = await fullAdminId();
  if (userId instanceof Response) return userId;
  if (userId === null) return Response.json({ error: "forbidden" }, { status: 403 });

  let body: z.infer<typeof seenSchema>;
  try {
    body = seenSchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const ok = await markNoticeSeen(userId, body.source, body.id, Date.now());
  return ok ? new Response(null, { status: 204 }) : Response.json({ error: "unknown_notice" }, { status: 400 });
}
