-- 宣告式插件被更新換掉之前的那一份:新表 `declarative_previous`(一個插件一列)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0026 的體例(見 0025 檔頭)。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 為什麼要有這張表:registry 只留最新版(相容性斷掉時才多留一版),所以更新之後發現有問題,
-- registry 不一定還拿得到上一版。安裝路由在內容真的變了的那次更新,把 declarative_extensions
-- 原本那一列存到這裡;後台的「回到上一版」拿它走同一條安裝流程,所有檢查照舊(遷移歷史對不上會擋)。
-- 退回之後被換掉的那一份又存回這裡,所以可以再前進回去。只留一份:多留沒有人會用,也更難說清楚。
--
-- 欄位與 declarative_extensions 同名同義,多一個 replaced_at(被換掉的時間)。
-- 移除插件時一起刪(src/ext/manager.ts)。
--
-- 執行期契約:src/app/api/registry/install/route.ts(寫入與 rollback)。
CREATE TABLE `declarative_previous` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`version` text NOT NULL,
	`source` text,
	`stylesheet` text,
	`scripts_approval` text,
	`replaced_at` integer NOT NULL
);
