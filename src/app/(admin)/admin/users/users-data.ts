import { asc, count, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, passkeys, sessions } from "@/lib/schema";
import { listStaffRoles } from "@/lib/staff-roles";
import { openablePageCount } from "@/ext/admin-access";
import { getExtRuntime } from "@/ext/loader";
import { createServices } from "@/ext/services";
import { readMemberFacets, type MemberFacetColumn } from "@/ext/member-facets";
import type { Locale } from "@/lib/i18n";
import type { RoleOption, UserRecord } from "./UsersTable";

// 成員頁的資料(伺服器端)。頁面(page.tsx)與匯出 CSV(GET /api/users/export)讀同一份,
// 表格上看到的人和匯出的人才會一樣。SessionUser 不帶 createdAt/passkey 數 —— 這裡自己查,
// 不動共用型別。
//
// 一次全部讀出來:頁面在瀏覽器上即時搜尋與篩選(users-filter.ts),不分頁。
//
// 1.60.0:插件的 facet(Extension.memberFacets,ext/member-facets.ts)也在這裡讀:所有人的 id
// 一次交給每個 facet,所有插件同時讀;讀壞的 facet 不出現,頁面照常。沒有插件宣告時不讀。
// 呼叫端(頁面、匯出)本來就只有管理員進得來,facet 跟著同一道門。

export interface UsersData {
  users: UserRecord[];
  /** 1.50.0:自訂角色(角色與權限頁建的),給角色選單、篩選與顯示名稱。 */
  roles: RoleOption[];
  /** 1.60.0:插件的 facet(表格的欄、篩選、匯出的欄、側欄段落);沒有就是空陣列。 */
  facets: MemberFacetColumn[];
}

export interface LoadUsersOptions {
  /** 後台語言(facet 的名稱與內容)。 */
  locale: Locale;
  /** 站台時區(交給 facet)。 */
  timeZone: string;
}

export async function loadUsers({ locale, timeZone }: LoadUsersOptions): Promise<UsersData> {
  const [rows, pkCounts, lastSeen, staffRoles, rt] = await Promise.all([
    db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        staffRoleId: users.staffRoleId,
        createdAt: users.createdAt,
      })
      .from(users)
      // 先加入的在前(與匯出同一個順序)。
      .orderBy(asc(users.createdAt), asc(users.id)),
    db()
      .select({ userId: passkeys.userId, n: count() })
      .from(passkeys)
      .groupBy(passkeys.userId),
    // Last active ≈ 最近一次 session 建立(sessions 會過期輪替,MAX(created_at)
    // 就是最近一次登入;比在 users 表加 last_login 欄位省一次寫路徑)。
    db()
      .select({ userId: sessions.userId, last: max(sessions.createdAt) })
      .from(sessions)
      .groupBy(sessions.userId),
    listStaffRoles(),
    getExtRuntime(),
  ]);
  const { facets, byUser } = await readMemberFacets(
    rt.enabled,
    rows.map((r) => r.id),
    { locale, timeZone, services: createServices },
  );
  const pkByUser = new Map(pkCounts.map((r) => [r.userId, r.n]));
  const seenByUser = new Map(lastSeen.map((r) => [r.userId, r.last]));
  return {
    users: rows.map((r) => {
      const own = byUser.get(r.id);
      return {
        ...r,
        passkeys: pkByUser.get(r.id) ?? 0,
        lastActiveAt: seenByUser.get(r.id) ?? null,
        ...(own ? { facets: own } : {}),
      };
    }),
    roles: staffRoles.map((role) => ({
      id: role.id,
      name: role.name,
      pages: openablePageCount(role.access),
    })),
    facets,
  };
}
