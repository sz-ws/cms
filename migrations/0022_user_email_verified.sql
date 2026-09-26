-- users 加一欄 `email_verified_at`:這個帳號的 Email 何時被證明過是本人的(1.54.0)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0021 的體例。drizzle 的
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
-- ── 為什麼要這一欄 ─────────────────────────────────────────────────────────
--
-- 第三方登入(src/lib/login-accounts.ts)遇到 Email 相同的既有會員時,只有在
-- 「IdP 說 Email 已驗證」而且「這個帳號的 Email 也被證明過」時才自動綁上。
-- 少了後者,有人可以先用別人的信箱註冊(寄不出信時會員插件允許直接註冊,管理員也
-- 能手動建帳號)、設好密碼,等信箱主人用 Google 登入後被綁進這個帳號(帳號預先劫持)。
--
-- 誰會寫入:第三方登入以已驗證 Email 建立的帳號;會員插件的驗證碼流程(驗證碼登入、
-- 驗證後設定密碼、新會員)。管理員手動建立、直接註冊的帳號留 NULL。
-- 既有列一律 NULL:無從得知當初有沒有驗證過;會員下次用驗證碼登入時補上。

ALTER TABLE `users` ADD COLUMN `email_verified_at` integer;

-- 完成後:pnpm db:checksums && pnpm test:run test/migration-parity.test.ts && pnpm db:migrate:local

