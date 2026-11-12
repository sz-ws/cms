import { authErrorResponse, requireAuth } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { publicContentChanged } from "@/lib/public-cache";

// [core] 2.0:設定頁的「重新產生全部頁面」(PublicPagesRefreshCard)。每一筆會改公開頁的寫入本來就會
// 呼叫 publicContentChanged;這個按鈕給寫入不經過網站的情況(直接改資料庫、插件忘了通知),呼叫的是
// 同一個函式。只有管理員。

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const res = originErrorResponse(e);
    if (res) return res;
    throw e;
  }
  try {
    await requireAuth("admin");
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  publicContentChanged("admin:refresh");
  return Response.json({ ok: true });
}
