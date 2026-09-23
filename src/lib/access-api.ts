import {
  AuthError,
  assertMinRole,
  getSessionAccess,
  isFullAdmin,
  type SessionUser,
} from "./auth";
import {
  MEDIA_PATH,
  atLeast,
  canEditAnything,
  extensionLevel,
  levelOf,
  pageRefPath,
  type AccessLevel,
  type AccessMap,
  type GrantedLevel,
} from "@/ext/admin-access";

// 1.50.0:API 這一側的門(頁面那一側在 lib/access-guards.ts)。規則同頁面:預設角色照舊
// 是 requireAuth("admin") 的判斷(assertMinRole,用同一趟查到的 session);自訂角色看
// 授權,不夠就 403。插件 API 的門在
// app/api/ext/[extId]/[[...path]]/route.ts(它要先比對到哪一條 route 才知道看哪一格)。

export type MediaAction = "browse" | "upload" | "manage";

/**
 * 管理媒體庫(改替代文字、刪檔)要媒體庫的「編輯」。在內容表單裡挑圖(瀏覽)與上傳,
 * 另外也開給能編輯任何一頁的角色 —— 編輯商品要能放商品圖,不必先把整個媒體庫交出去。
 */
function mediaLevel(access: AccessMap, action: MediaAction): AccessLevel {
  const media = levelOf(access, MEDIA_PATH);
  if (action !== "manage" && canEditAnything(access)) return "edit";
  return media;
}

function mediaNeeded(action: MediaAction): GrantedLevel {
  return action === "browse" ? "view" : "edit";
}

/**
 * 媒體 API 的門:預設角色照舊只有管理者;自訂角色權限不夠 throw
 * AuthError(403)。通過時回傳以管理者身分執行的使用者。
 */
export async function requireMediaAccess(action: MediaAction): Promise<SessionUser> {
  const session = await getSessionAccess();
  if (!session) throw new AuthError(401);
  if (!session.access) return assertMinRole(session.user, "admin");
  if (!atLeast(mediaLevel(session.access, action), mediaNeeded(action))) {
    throw new AuthError(403);
  }
  return { ...session.user, role: "admin" };
}

/**
 * 掛在某個 extension 紀錄上的 core 資料(狀態描述,/api/record-status/notes):預設角色
 * 照舊只有管理者;自訂角色看這個 extension 任一頁的權限(讀要檢視、寫要編輯)。
 */
export async function requireExtensionAccess(
  extId: string,
  needed: GrantedLevel,
): Promise<SessionUser> {
  const session = await getSessionAccess();
  if (!session) throw new AuthError(401);
  if (!session.access) return assertMinRole(session.user, "admin");
  if (!atLeast(extensionLevel(session.access, extId), needed)) throw new AuthError(403);
  return { ...session.user, role: "admin" };
}

/**
 * 這個人在這幾頁各是哪一級 —— 畫面決定要不要顯示寫入的按鈕用(真正的門仍在 API)。
 * pages 是 { 名字: "<extId>" | "<extId>/<slug>" }。預設角色:真正的管理者每一頁都是
 * edit,其餘 none(不查資料庫)。自訂角色:照它的授權(查一次 session)。
 */
export async function adminPageLevels<K extends string>(
  user: SessionUser,
  pages: Readonly<Record<K, string>>,
): Promise<Record<K, AccessLevel>> {
  const access = user.staffRole ? ((await getSessionAccess())?.access ?? {}) : null;
  const out = {} as Record<K, AccessLevel>;
  for (const name of Object.keys(pages) as K[]) {
    const path = pageRefPath(pages[name]);
    if (access === null) out[name] = isFullAdmin(user) ? "edit" : "none";
    else out[name] = path ? levelOf(access, path) : "none";
  }
  return out;
}
