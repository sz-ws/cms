import type { AdminMenuItem, AdminNavSection } from "./admin-menu";
import type { ResolvedStatusSets } from "./record-status";
import { defineValueSlot } from "./slots";

// 本體自己宣告的插槽(機制見 slots.ts)。插件宣告的插槽放在插件自己的資料夾裡。

/**
 * 後台側欄的分區(預設五區:workspace、content、commerce、shop、system)。填的人可以改名、加區、
 * 排序、決定收合方式;項目再用 AdminSidebarItems 的 `section` 指過去。輸出經 normalizeAdminSections
 * 收斂(ext/admin-menu.ts)。
 */
export const AdminSidebarSections = defineValueSlot<AdminNavSection[]>("admin.sidebar.sections");

/** 後台側欄的項目:固定項加上每個啟用中插件的後台頁。填的人可以增刪、改名、換分區、排序。 */
export const AdminSidebarItems = defineValueSlot<AdminMenuItem[]>("admin.sidebar.items");

/**
 * 後台的狀態組(`<extId>:<setId>` → 狀態 → 名稱、色調、說明)。填的人可以改名(label)或補說明
 * (addon);系統狀態本身不變,只影響後台怎麼講。輸出經 normalizeStatusSets 收斂(ext/record-status.ts)。
 */
export const AdminStatusSets = defineValueSlot<ResolvedStatusSets>("admin.status-sets");
