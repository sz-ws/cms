import type { UserRecord } from "./UsersTable";

// 1.56.0:成員頁分兩組 —— 後台人員(管理員、工作人員、自訂角色)與會員(一般訪客帳號)。
// 自訂角色的 users.role 存的是 "guest"(migrations/0021),所以一定要看 staffRoleId。
// 目前看哪一組記在網址的 ?view=members(沒有 = 後台人員),重新整理、分享連結都留在同一組。

export type UsersView = "staff" | "members";

export const USERS_VIEW_PARAM = "view";

function isStaffUser(user: Pick<UserRecord, "role" | "staffRoleId">): boolean {
  return user.role !== "guest" || user.staffRoleId !== null;
}

export function parseUsersView(raw: string | string[] | undefined | null): UsersView {
  return raw === "members" ? "members" : "staff";
}

export function usersInView(users: readonly UserRecord[], view: UsersView): UserRecord[] {
  return users.filter((user) => isStaffUser(user) === (view === "staff"));
}

/** 切換分組後的網址:保留其他參數,後台人員(預設)不帶 view。 */
export function hrefForView(current: string, view: UsersView): string {
  const url = new URL(current);
  if (view === "members") url.searchParams.set(USERS_VIEW_PARAM, "members");
  else url.searchParams.delete(USERS_VIEW_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
