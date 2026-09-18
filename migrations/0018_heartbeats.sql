-- 排程心跳搬出 settings:新表 `heartbeats`(一個 key 一列:最後一次發生的 epoch ms)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0017 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 凍結在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 表**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
-- 執行期契約:src/lib/heartbeats.ts。
--
-- ── 為什麼要搬 ──────────────────────────────────────────────────────────────
--
-- 三種心跳以前都存在 settings 表:
--   * ext.cron.lastTick         —— cron extension 每次 tick 成功後寫(每分鐘)
--   * core.jobs.lastSweep       —— lazy sweep 節流用(沒有 cron 時,最多每分鐘)
--   * core.jobs.lastRun.<id>    —— runDueJobs 跑完每支 core job 後寫(每分鐘)
--
-- settings 的讀取靠「版本戳」快取(src/lib/settings.ts + src/lib/request-stamps.ts):
-- 每個 request 先算 COUNT + MAX(updated_at),戳沒變就重用已 parse 的整包 Map。
-- 心跳每分鐘寫一次,等於每分鐘把這個戳推一格 —— 於是每一分鐘的第一個 request
-- (公開站也算,幾乎每頁都讀 settings)都得重讀整張 settings 表。快取實際上只
-- 撐一分鐘,而推動它失效的東西沒有一個是「設定」。
--
-- 心跳是**觀測值**,不是設定:沒有人會在設定頁改它,也沒有任何讀取路徑需要它
-- 跟 siteTitle 一起被快取。搬到自己的表之後,settings 的戳只會因為真正的設定
-- 變更而動;心跳表不參與任何版本戳(request-stamps.ts 的合併查詢不含它)。
--
-- ── 為什麼 key 沿用原本的字串 ──────────────────────────────────────────────
--
-- 同一個名字在兩張表之間搬家,grep 得到新舊兩端,也讓下面的資料搬移只是一句
-- INSERT … SELECT。ext.cron.lastTick 仍由 cron extension 寫、core 只讀
-- (見 src/lib/jobs.ts 的 LAST_CRON_TICK_KEY 註解)。
--
-- ── 資料搬移 ────────────────────────────────────────────────────────────────
--
-- 先把現值抄過來再刪:admin 的 Cron 頁不會在部署後短暫顯示「從未收到」,lazy
-- sweep 也不會因為讀不到 lastSweep 而多跑一輪。settings.value 是 JSON 字串,
-- 數字的 JSON 就是它的十進位字面值,CAST 成 INTEGER 即得 epoch ms。
-- settings 裡的舊列一併刪除:留著的話沒有人讀,也沒有人會再更新它 —— 一份永遠
-- 停在部署當下的「最後一次」,只會在哪天被誤讀。刪除會讓 settings 的戳動一次,
-- 等同一次普通的設定儲存。
--
-- 部署順序兩個方向都不會讓排程停擺:新程式碼先上、本表還沒建 → 讀心跳一律當作
-- 「從沒發生」,lazy sweep 照跑(src/lib/heartbeats.ts 的 fail-open);cron tick
-- 寫不進心跳會回 500,由 scheduled 端照既有管道回報 —— 那正是「migration 還沒套」
-- 該被看見的方式。migration 先套、舊程式碼還在 → 舊碼把心跳寫回 settings,那幾列
-- 沒有新碼會讀,只是多幾列。

CREATE TABLE IF NOT EXISTS heartbeats (
  key  TEXT PRIMARY KEY,   -- 心跳名稱,沿用原 settings key(見上)
  at   INTEGER NOT NULL    -- 最後一次發生的 epoch ms
);

INSERT OR IGNORE INTO heartbeats (key, at)
  SELECT key, CAST(value AS INTEGER) FROM settings
   WHERE key IN ('ext.cron.lastTick', 'core.jobs.lastSweep')
      OR key LIKE 'core.jobs.lastRun.%';

DELETE FROM settings
 WHERE key IN ('ext.cron.lastTick', 'core.jobs.lastSweep')
    OR key LIKE 'core.jobs.lastRun.%';
