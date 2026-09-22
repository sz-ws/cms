-- 宣告式插件插入 script 的核准紀錄:declarative_extensions 加一欄 scripts_approval。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0019 的體例。drizzle 的
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
-- ── 為什麼是一欄,不是 settings ─────────────────────────────────────────────
--
-- 核准屬於「這一列安裝」:卸載時整列刪掉,核准跟著消失,重裝就要重新核准。放在
-- settings 會在卸載後留下來,同一份 manifest 重裝時直接生效 —— 那等於沒人看過
-- 就執行。欄位內容是 JSON {hash, by, at},NULL = 沒核准或已停用。

ALTER TABLE declarative_extensions ADD COLUMN scripts_approval text;
