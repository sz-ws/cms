-- 會員自訂資料:新表 `user_fields`(一位使用者的一個名稱一列)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0025 的體例(見 0025 檔頭)。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 為什麼要有這張表:插件要記在「這個人」身上的東西(例如結帳時填的電話、收件地址與收件地區,之後還會有
-- 慣用的配送方式、要不要收電子報…),以前每個插件各開一張表、各寫一組 migration,core 不知道它們是個人
-- 資料。現在共用這一張,名稱一律是 `<插件 id>.<欄位>`,插件經 src/lib/user-fields.ts 只讀寫自己那一段。
--
-- 語意:
--   key    `<插件 id>.<欄位>`,例如 members.phone。
--   value  JSON(字串、數字、布林、物件),序列化後最多 4,000 字(執行期檢查)。
--   刪掉使用者時整組跟著刪(外鍵 ON DELETE CASCADE)。不是放密碼、金鑰的地方:這裡沒有加密。
--
-- 執行期契約:src/lib/user-fields.ts。
CREATE TABLE `user_fields` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
