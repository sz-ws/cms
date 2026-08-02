-- D1 用量預警:新表 `storage_history`(每次探測一列:當下的資料庫大小)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0014 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 停在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
--
-- 表與索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
--
-- ── 為什麼是快照,不是 trigger 計數器 ──────────────────────────────────────
--
-- 本檔的第一版曾經是「4 張表 × 3 個 trigger」的逐表計數器(累加
-- length(CAST(col AS BLOB)))。2026-08-02 整個換掉,理由:
--
--   **D1 每一次查詢的 meta 都會回 `size_after`** —— 官方定義是「the size of the
--   database after the query is successfully applied」。那是**真實的資料庫大小**,
--   權威、免費、搭在既有查詢上回來,不需要任何設定或 API token。
--
-- 對照之下,trigger 計數器:
--   1. 只能算**邏輯位元組**(TEXT 欄長度總和)。不含 INTEGER 欄、列 header、
--      索引、page slack,而且 FTS5 的影子表(content_fts_data/_idx/_docsize/
--      _content)根本掛不上 trigger —— 系統性低估,而且低估多少無從得知。
--   2. 要付**永久 2 倍的寫入放大**(D1 按 rows written 計費),為的是回答
--      「哪張表在漲」——那個問題一輩子可能只需要問一次,而且到時候臨時跑一次
--      count(*) 就有答案,不需要為它常駐一套 trigger。
--
-- 真正要盯的指標只有一個:**離上限還有多遠**。D1 的單庫上限是 500 MB(Free)/
-- 10 GB(Workers Paid,官方明訂不可調升),而且 **D1 沒有 VACUUM** —— 刪除不會把
-- 空間還回來(auto_vacuum=0 且所有 PRAGMA 被 authorizer 擋掉),撞到只能
-- export → 建新 DB → import → 換 database_id 重部署,有停機。
-- 所以預警的價值全部在「早」,而 size_after 是唯一講真話的來源。
--
-- 存成歷史(而非單列覆寫)是因為快照幾乎不佔空間,但**成長速率**比當下數值更有
-- 用:「還剩 300MB」不知道急不急,「兩週漲了 80MB」就知道了。
--
-- 細節見 docs/spec-archive-capability.md §2 與 §9。

CREATE TABLE IF NOT EXISTS storage_history (
  at          INTEGER PRIMARY KEY,   -- 探測時間 epoch ms(同時是主鍵:一毫秒一列足矣)
  size_after  INTEGER NOT NULL,      -- D1 meta.size_after,單位 byte
  rows_read   INTEGER,               -- 該次探測查詢自身的成本(觀測用,可為 NULL)
  note        TEXT                   -- 保留欄:未來標記「歸檔後」「清理後」等事件
);

-- 唯一的掃描路徑:取最近 N 列算成長速率。at 已是主鍵(B-tree 有序),
-- 但顯式宣告 DESC 索引讓「最新幾列」不需要反向掃整棵樹。
CREATE INDEX IF NOT EXISTS storage_history_at_desc ON storage_history (at DESC);
