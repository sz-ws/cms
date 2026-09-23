import {
  DASHBOARD_PATH,
  MEDIA_PATH,
  areaKey,
  atLeast,
  levelOf,
  type AccessMap,
} from "@/ext/admin-access";

// 1.52.0:儀表板上的每張卡、每個數字都來自某個後台頁(內容類型的列表頁、媒體庫、成員頁……)。
// 自訂角色只看得到它打得開的那些:打不開的頁的卡片與數字不顯示,「新增」要那一頁的編輯。
//
// 預設角色(admin / editor / guest)沒有 access,這裡回 null = 照舊全部顯示,行為與 1.51.0
// 相同。純函式(不碰 React / D1),儀表板頁、aggregate、dashboard-cards 與測試共用。

export interface DashboardViewer {
  /** 這個後台連結(卡片的來源頁)打不打得開:檢視以上。 */
  canOpen: (href: string) => boolean;
  /** 能不能在這一頁新增(卡片上的「新增」、快速新增選單):要編輯。 */
  canCreate: (href: string) => boolean;
  /** 成員數:成員頁只有管理者打得開。 */
  users: boolean;
  /** 資料庫用量:屬於系統設定,只有管理者。 */
  database: boolean;
  /** 儲存空間:跟著媒體庫。 */
  storage: boolean;
}

/** 自訂角色的 access → 儀表板要濾掉什麼;預設角色(null)不濾。 */
export function dashboardViewer(access: AccessMap | null): DashboardViewer | null {
  if (!access) return null;
  const level = (href: string) => levelOf(access, areaKey(href));
  return {
    canOpen: (href) => atLeast(level(href), "view"),
    canCreate: (href) => level(href) === "edit",
    users: false,
    database: false,
    storage: atLeast(levelOf(access, MEDIA_PATH), "view"),
  };
}

/**
 * 登入者 → 儀表板 viewer。自訂角色照它的 access;預設的工作人員(editor)在後台只打得開
 * 儀表板,所以也照「只有儀表板」過濾 —— 否則它會看到連到打不開的頁的卡片與營運數字。
 * 管理員與沒有 session 的情況回 null(照舊全部顯示)。
 */
export function dashboardViewerFor(
  session: { user: { role: string }; access: AccessMap | null } | null,
): DashboardViewer | null {
  if (!session) return null;
  if (session.access) return dashboardViewer(session.access);
  if (session.user.role === "editor") return dashboardViewer({ [DASHBOARD_PATH]: "view" });
  return null;
}

