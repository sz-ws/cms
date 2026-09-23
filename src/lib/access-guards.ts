import { notFound, redirect } from "next/navigation";
import {
  AuthError,
  getSessionAccess,
  requireAuth,
  type SessionUser,
  type UserRole,
} from "./auth";
import { currentAccessScope, enterAccessScope } from "./access-scope";
import {
  DASHBOARD_PATH,
  MEDIA_PATH,
  adminPageLevel,
  atLeast,
  customRoleCanOpen,
  firstOpenablePath,
  levelOf,
  type AccessLevel,
  type AccessMap,
} from "@/ext/admin-access";

// 1.50.0:自訂角色的門。每一扇門都是「預設角色照舊、自訂角色看授權」:
//   - 預設角色(admin / editor / guest):呼叫原本那一道 requireAuth(minRole),行為與
//     1.49.0 完全相同。
//   - 自訂角色:這扇門要求的權限夠 → 開門(lib/access-scope.ts),之後這個 request 裡的
//     getSessionUser / requireAuth 看到的是 admin;不夠 → 頁面 404、API 403。
// 規則(哪一頁 / 哪條 API 看哪一格)在 ext/admin-access.ts;API 的門在 lib/access-api.ts
// (這個檔案帶 next/navigation,route handler 不該引它)。

type LevelOf = (access: AccessMap) => AccessLevel;

async function guardPage(levelFor: LevelOf, legacyMinRole: UserRole): Promise<SessionUser> {
  const session = await getSessionAccess();
  if (!session) throw new AuthError(401);
  if (!session.access) return requireAuth(legacyMinRole);
  if (!atLeast(levelFor(session.access), "view")) notFound();
  enterAccessScope({ needed: "view", levelOf: levelFor });
  return { ...session.user, role: "admin" };
}

/** 插件後台頁(/admin/ext/<extId>/<slug>)。預設角色照舊只有管理者。 */
export function guardExtAdminPage(
  extId: string,
  page: { slug: string; accessAs?: string },
): Promise<SessionUser> {
  return guardPage((access) => adminPageLevel(access, extId, page), "admin");
}

/**
 * 這一頁目前的人能不能改 —— 畫面用它收起新增、批次動作與儲存(真正的門在 API)。
 * 在頁面守門之後 render 的 server component 裡呼叫。預設角色一律 true(打得開這一頁,
 * 就照這一頁原本的規則);自訂角色要這一頁的授權是「編輯」。
 */
export async function canEditCurrentPage(): Promise<boolean> {
  const session = await getSessionAccess();
  if (!session?.access) return true;
  const scope = currentAccessScope();
  return scope !== null && atLeast(scope.levelOf(session.access), "edit");
}

/** 媒體庫頁。預設角色照舊只有管理者。 */
export function guardMediaPage(): Promise<SessionUser> {
  return guardPage((access) => levelOf(access, MEDIA_PATH), "admin");
}

/**
 * 儀表板。預設角色不變(layout 已把訪客送去帳戶頁)。自訂角色沒有儀表板時,
 * 送到側欄順序裡第一個打得開的頁;一頁都沒有就是帳戶頁。
 */
export async function guardDashboard(): Promise<void> {
  const session = await getSessionAccess();
  if (!session?.access) return;
  if (atLeast(levelOf(session.access, DASHBOARD_PATH), "view")) return;
  // 選單要整個 extension runtime;只有這條路需要,用到才載入。
  const { getFullAdminNavGroups } = await import("./admin-nav");
  const groups = await getFullAdminNavGroups();
  redirect(firstOpenablePath(groups, customRoleCanOpen(session.access)) ?? "/admin/account");
}
