import type { MessageKey } from "@/lib/i18n";
import type { DateFormatter } from "@/lib/datetime";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import type { MemberFacetColumn } from "@/ext/member-facets";
import type { RoleOption, UserRecord } from "@/app/(admin)/admin/users/UsersTable";
import { roleLabel } from "@/app/(admin)/admin/users/users-filter";
import type { UsersView } from "@/app/(admin)/admin/users/users-view";

// 1.59.0:成員匯出的欄位(純函式,路由與測試共用)。
//
// 欄位是店家在表格上看得到、放進試算表有用的:姓名、Email、角色(自訂角色寫它的名字)、
// 加入時間、最近上線。Passkey 數與使用者 ID 不放。時間照站台時區寫成
// 2026-09-18 14:05:00(DateFormatter.stamp),Excel 打開就能排序;從未上線留白。
// 第三方登入拿不到 email 的帳號(合成的 placeholder email)Email 留白,不露內部字串。
// 1.60.0:插件的 facet 各一欄(接在最後),寫 badge;不適用的人留白。

const HEADER: MessageKey[] = [
  "usersTable.csvName",
  "usersTable.csvEmail",
  "usersTable.role",
  "usersTable.joined",
  "usersTable.lastActive",
];

export function usersCsvRows(
  users: readonly UserRecord[],
  roles: readonly RoleOption[],
  t: (key: MessageKey) => string,
  dates: DateFormatter,
  facets: readonly MemberFacetColumn[] = [],
): string[][] {
  return [
    [...HEADER.map((key) => t(key)), ...facets.map((facet) => facet.label)],
    ...users.map((user) => [
      user.name,
      isPlaceholderEmail(user.email) ? "" : user.email,
      roleLabel(user, t, roles),
      dates.stamp(user.createdAt),
      user.lastActiveAt === null ? "" : dates.stamp(user.lastActiveAt),
      ...facets.map((facet) => user.facets?.[facet.key]?.value?.badge ?? ""),
    ]),
  ];
}

/** members-2026-09-28.csv / staff-2026-09-28.csv(日期是站台時區的今天)。 */
export function usersCsvFilename(view: UsersView, dates: DateFormatter, now: number): string {
  return `${view === "members" ? "members" : "staff"}-${dates.dayKey(now)}.csv`;
}
