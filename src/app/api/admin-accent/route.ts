import { requireAuth, authErrorResponse } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { normalizeHex } from "@/lib/color";
import { DEFAULT_ADMIN_ACCENT } from "@/lib/admin-accent";

// 後台主色(core.adminAccent)。瀏覽器只在本機沒有快取時打這支(第一次登入、換電腦、
// 清過資料),拿到就存進 localStorage,之後不再問 —— 規則見 lib/admin-accent.ts。
// 任何登入者都能讀:guest 也看得到後台殼(帳戶頁)。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("guest");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const accent =
    normalizeHex(await getSetting<string>("core.adminAccent", DEFAULT_ADMIN_ACCENT)) ??
    DEFAULT_ADMIN_ACCENT;
  return Response.json({ accent }, { headers: { "Cache-Control": "private, no-store" } });
}
