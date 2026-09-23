-- 自訂角色:新表 `staff_roles`,users 加一欄 `staff_role_id`。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0020 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 凍結在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 表/欄位/索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
-- 執行期契約:src/ext/admin-access.ts(規則)、src/lib/staff-roles.ts(讀寫)、
-- src/lib/auth.ts(getSessionUser 套用)。
--
-- ── 形狀 ──────────────────────────────────────────────────────────────────
--
-- admin / editor / guest 仍是 users.role 的三個預設,行為不變。自訂角色是站台自己
-- 取名的一份「哪些後台頁可以看、可以改」:access 是 JSON 物件,鍵是後台頁的路徑
-- (/admin、/admin/media、/admin/ext/<extId>[/<slug>]),值是 "view" 或 "edit";
-- 沒列的頁 = 無權限。鍵用路徑而不是側欄的顯示名稱:站台改名、搬分區都不影響授權,
-- 新裝的插件頁一開始對所有自訂角色都是「無」。
--
-- ── 為什麼 users.role 同時寫成 'guest' ──────────────────────────────────────
--
-- 指派自訂角色時 users.role 一律寫 'guest'、staff_role_id 指向角色。自訂角色只會
-- 縮小權限:它在「被授權的頁與 API」裡以管理者身分執行,其餘地方是一般登入者。
-- 萬一角色那一列消失(ON DELETE SET NULL,或有人直接改資料庫),這個人退回的是
-- 權限最低的訪客,而不是能呼叫所有插件 API 的編輯者。正常的刪除路徑
-- (DELETE /api/roles/<id>)在同一個 batch 裡先把成員改成訪客,再刪角色。

CREATE TABLE `staff_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`access` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

ALTER TABLE `users` ADD COLUMN `staff_role_id` text REFERENCES `staff_roles`(`id`) ON DELETE SET NULL;

CREATE INDEX `users_staff_role_idx` ON `users` (`staff_role_id`);
