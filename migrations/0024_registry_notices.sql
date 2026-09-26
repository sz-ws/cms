-- 上新通知(registry 協定的 notices)的兩張小表:每個來源的通知快取、每位管理員看過哪些(1.56.0)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0022 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 凍結在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 紀律(test/migration-parity.test.ts 機器驗證,紅燈擋在 merge 前):
--   * 寫完 SQL 後跑 `pnpm db:checksums` 把本檔登錄進 append-only 帳本
--     (migrations/meta/_checksums.json);登錄後這個檔就不該再被改一個字。
--   * 表/欄位/索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的
--     規則 —— schema.ts 是資料庫的完整描述,不是產生器的輸入。
--   * drizzle 建模不了的構造(FTS5 虛擬表等)是唯一例外:加進該測試的
--     RAW_SQL_ONLY_TABLES 清單,並在 schema.ts 相鄰處留註解,別讓它失聯。
--   * 無 trigger、字串常值內無 `;` 或 `--`(該測試的 SQL 切分器假設如此;
--     真需要時先擴充切分器)。
--   * 設計取捨寫在這個檔頭 —— 讓下一個讀 SQL 的人拿得到「為什麼」。
--
-- 完成後:pnpm db:checksums && pnpm test:run test/migration-parity.test.ts && pnpm db:migrate:local

--
-- ── registry_notices:每個來源一列 ─────────────────────────────────────────
--
-- 管理員打開後台時,只有「打開了通知、而且這一列超過 12 小時」的來源才在 waitUntil 裡
-- 重讀一次 registry.json(src/lib/registry-notice-store.ts)。fetched_at 在「開始抓」的那一刻
-- 就先寫上(INSERT … ON CONFLICT … WHERE fetched_at 已過期),同時開好幾個分頁不會一起抓,
-- registry 連不上時 12 小時內也不再試 —— 沒有管理員進後台,就沒有任何對外連線。
-- notices 是解析、消毒過的 JSON 陣列(RegistryNotice[])。
--
-- 刻意不放在 settings:每次更新都會推動 settings 的版本戳,讓整包設定快取失效
-- (同 0018 heartbeats 的理由)。
--
-- ── registry_notice_seen:(user_id, source, notice_id) ────────────────────
--
-- 「只跳一次」= 每位管理員一次。任何關閉方式都算看過。seen_at 也是「同一位管理員 24 小時
-- 內最多一則」的依據(以 user_id 開頭的主鍵就夠這個查詢用)。刪掉使用者時一起刪。
-- 不記 notice 的內容:通知撤下後這裡留著的只是一組 id。

CREATE TABLE `registry_notices` (
	`source` text PRIMARY KEY NOT NULL,
	`notices` text NOT NULL,
	`fetched_at` integer NOT NULL
);

CREATE TABLE `registry_notice_seen` (
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`notice_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `source`, `notice_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

