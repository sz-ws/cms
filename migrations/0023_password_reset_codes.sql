-- 新表 `password_reset_codes`:忘記密碼的 Email 驗證碼(1.56.0)。
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
-- ── 為什麼這樣存 ───────────────────────────────────────────────────────────
--
-- 一個 Email 一列(PRIMARY KEY email),重寄就覆蓋碼的欄位,舊碼立刻失效。
-- 以 Email 而不是 user_id 當鍵:申請時不管有沒有這個帳號都寫一列,冷卻與次數的
-- 回應才會一模一樣(否則「60 秒內再按一次」就能分辨帳號存不存在)。
--
-- - nonce:每次發碼新產生的隨機值,和 Email、驗證碼一起進 HMAC(金鑰由 SECRETS_KEY
--   經 HKDF 導出,見 src/lib/password-reset-codes.ts)。只拿到 D1 的人算不出碼。
-- - code_hash:只存雜湊;驗證成功或錯滿 5 次後設成 NULL(= 這組碼不能再用)。
-- - attempts:這組碼試過幾次(先原子地記一次再比對,併發猜碼也不會超過上限)。
-- - sent_at:最後一次寄出的時間,60 秒內不能重寄;一天前的列在下次發碼時順手清掉
--   (sent_at 的索引就是為了這個)。
-- - expires_at:10 分鐘。
--
-- 沒有 foreign key 指向 users:帳號不存在時也要有一列(見上),帳號刪除後殘留的列
-- 最晚一天內被清掉,而且它的碼在確認時一定對不到帳號。

-- 完成後:pnpm db:checksums && pnpm test:run test/migration-parity.test.ts && pnpm db:migrate:local

CREATE TABLE `password_reset_codes` (
	`email` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`code_hash` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);

CREATE INDEX `password_reset_codes_sent_idx` ON `password_reset_codes` (`sent_at`);
