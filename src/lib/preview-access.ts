// [core] 2.0 草稿預覽的把關(middleware 用)。
//
// Next 的 draft mode cookie(__prerender_bypass)的值是這次建置的 previewModeId:每個編輯拿到的都一樣,
// 到下一次部署前都有效,也不綁任何人。/api/preview 只在開的那一刻驗身分;之後要是編輯登出、被降成
// 會員、或 cookie 被複製到別的瀏覽器,光憑這個 cookie 仍看得到草稿。所以帶著它的請求,middleware
// 每次都問一次:這個瀏覽器現在是不是一位編輯的有效 session。不是,就把 cookie 從請求拿掉(頁面照
// 一般訪客回應,快取照常命中)並在回應裡刪掉。
//
// 只用 D1 binding 直接查,不 import drizzle / auth.ts:middleware 在 Worker 的前門,每個冷啟動都要
// 編譯它,這裡越小越好。判斷與 auth.ts 的 requireAuth("editor") 相同:session 存在且未過期,
// users.role 是 editor / admin,或有自訂角色(自訂角色的人在授權範圍外的身分就是 editor)。

/** Next 的 draft mode cookie 名稱(next/dist/server/api-utils 的 COOKIE_NAME_PRERENDER_BYPASS)。 */
export const PREVIEW_COOKIE = "__prerender_bypass";

const EDITOR_SESSION_SQL =
  "SELECT u.role AS role, s.expires_at AS expiresAt, r.id AS staffRoleId FROM sessions s " +
  "JOIN users u ON u.id = s.user_id LEFT JOIN staff_roles r ON r.id = u.staff_role_id WHERE s.id = ? LIMIT 1";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface EditorRow {
  role: string;
  expiresAt: number;
  staffRoleId: string | null;
}

/**
 * 這個 session cookie 的值現在是不是一位編輯(editor 以上,或自訂角色)。沒有值、查不到、過期、
 * 查詢出錯 → false(預覽關掉、頁面照一般訪客回應;寧可多按一次預覽,也不把草稿給錯的人)。
 */
export async function isEditorSession(db: D1Database, sessionToken: string | undefined, now = Date.now()): Promise<boolean> {
  if (!sessionToken) return false;
  try {
    const row = await db.prepare(EDITOR_SESSION_SQL).bind(await sha256Hex(sessionToken)).first<EditorRow>();
    if (!row || row.expiresAt <= now) return false;
    return row.role === "editor" || row.role === "admin" || row.staffRoleId !== null;
  } catch (error) {
    console.error("[preview] could not check the session; preview is off for this request", error);
    return false;
  }
}

/** Cookie 標頭拿掉 draft mode cookie 之後的樣子(其餘 cookie 原樣保留)。 */
export function withoutPreviewCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${PREVIEW_COOKIE}=`))
    .join("; ");
}
