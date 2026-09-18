-- 每一筆紀錄的狀態描述:新表 `record_status_notes`(一筆紀錄的一個狀態一列)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0017 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 凍結在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 表**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
-- 執行期契約:src/lib/record-status-notes.ts;狀態組的定義在 src/ext/record-status.ts。
--
-- ── 為什麼是 core 的表 ─────────────────────────────────────────────────────
--
-- 狀態本身是各插件的(訂單、經銷訂單、佣金),存在各自的表。但「在某一筆上補一句
-- 描述」(待後續處理、無效訂單…)是同一件事,而且要能被別的插件或外部程式呼叫。
-- 放在 core 一張表,以狀態組 `<extId>:<setId>` + 紀錄 id + 狀態為鍵:任何宣告了
-- statusSets 的插件都能用,不必每個插件各做一張、各開一個端點。
--
-- 鍵裡有狀態:描述說的是「這一筆在這個階段」的事(已付款 → 待冷凍配送排程)。
-- 紀錄換到下一個狀態,上一個階段的描述自然不再顯示,不會留下過期的說明;
-- 回到原狀態時又看得到。
--
-- 描述不是狀態:它不參與任何轉移、不影響庫存或金流,只給後台的人看。所以不做
-- 歷史版本 —— 改了就是改了;要追誰改的,看 updated_by / updated_at。
--
-- 編號跳過 0018,留給排程心跳(0018_heartbeats,另一條分支)。兩者互不相干,
-- wrangler 依檔名套用,先後不影響。

CREATE TABLE `record_status_notes` (
	`status_set` text NOT NULL,
	`record_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`status_set`, `record_id`, `status`)
);
