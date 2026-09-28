import { requireAuth, authErrorResponse } from "@/lib/auth";
import { csvResponse } from "@/lib/csv";
import { getDateFormatter } from "@/lib/datetime-server";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { loadUsers } from "@/app/(admin)/admin/users/users-data";
import { filterUsers, parseUsersFilter } from "@/app/(admin)/admin/users/users-filter";
import { usersCsvFilename, usersCsvRows } from "./users-csv";

// GET /api/users/export?view=&q=&role=&joinedFrom=&joinedTo=&activeFrom=&activeTo=
// → 成員頁目前那組條件下的**所有**人(CSV,不分頁)。
//
// 條件的網址寫法、篩選本身都跟畫面共用 users-filter.ts(同一份 parse 與 filterUsers),
// 資料跟頁面共用 users-data.ts,所以匯出的人就是表格上顯示的人。
//
// 守門同成員頁:只有管理員(requireAuth("admin");/admin/users 是 admin-only,自訂角色
// 授權不到)。GET 不做 assertSameOrigin:瀏覽器點下載連結是同源 GET,不帶 Origin
// (見 api/export/route.ts 的說明);回應只會進到點的人自己的瀏覽器。其他後台匯出也
// 沒有頻率限制,這裡照同一個做法。

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const locale = await getLocale();
  const [{ users, roles }, dates] = await Promise.all([loadUsers(), getDateFormatter(locale)]);
  const m = getMessages(locale);
  const filter = parseUsersFilter(
    new URL(req.url).searchParams,
    roles.map((role) => role.id),
  );
  const rows = filterUsers(users, filter, dates.timeZone);
  return csvResponse(
    usersCsvFilename(filter.view, dates, Date.now()),
    usersCsvRows(rows, roles, (key) => m[key], dates),
  );
}
