import { getSessionAccess } from "@/lib/auth";
import { areaKey, sessionCanOpen } from "@/ext/admin-access";
import { askAdminAttention } from "@/ext/admin-attention";
import { getExtRuntime } from "@/ext/loader";

// 1.77.0:GET /api/admin/attention → { counts: { "<後台路徑>": 件數 }, unknown?: ["<這次問不到的後台路徑>"] }
// 側欄(components/admin/attention.tsx)問「哪幾頁現在有事在等」,有的那一頁旁邊畫一個點。件數由插件從插槽
// AdminAttention 報(ext/admin-attention.ts);沒有事的頁不在 counts 裡。
//
// 只問這個人打得開的頁,判斷跟側欄是同一個(ext/admin-access.ts 的 sessionCanOpen):管理員全部、自訂角色是
// 檢視以上的頁、editor 只有儀表板。訪客(一般會員)的後台只有自己的帳戶頁:直接回空的,不載入插件那一層,
// 也不問任何來源。
// GET 沒有狀態變更,不需要 assertSameOrigin;回應因人而異,不進任何快取。

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(): Promise<Response> {
  const session = await getSessionAccess();
  // 形狀同 authErrorResponse(lib/auth.ts)。
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (session.user.role === "guest") return Response.json({ counts: {} }, { headers: NO_STORE });

  const canOpen = sessionCanOpen(session);
  const rt = await getExtRuntime();
  // 權限的單位是頁(路徑):來源報的網址帶著篩選(?status=…)時,看的是那一頁本身。
  // 帳戶頁(/admin/account)側欄一律留著,這裡照權限表判斷:它不在任何角色的權限表裡,所以只有管理員問得到
  // 報在那一頁的來源 —— 個人的事不該從「這一頁有幾件」這條路給。
  const { counts, unknown } = await askAdminAttention(rt.slots, (href) => canOpen === null || canOpen(areaKey(href)));
  // unknown:這次問不到的頁(來源出錯或逾時);側欄留著那幾頁原本的點。沒有就不帶這一欄。
  return Response.json(unknown.length ? { counts, unknown } : { counts }, { headers: NO_STORE });
}
