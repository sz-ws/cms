-- AI 連線(外部 AI App 經 MCP 操作後台)的授權資料:四張新表 + agent_audit 多一欄 `app`。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0024 的體例。drizzle 的
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
-- 執行期契約:src/lib/mcp/(授權)、src/ext/mcp-server.ts(工具呼叫)。
--
-- ── 為什麼是四張表 ──────────────────────────────────────────────────────────
--
-- 外部 AI App(Claude、ChatGPT…)照 MCP 的授權規格走 OAuth 2.1:App 先自行登記
-- (動態註冊),站方管理員登入後按「允許」,App 拿授權碼換權杖。四個東西的壽命
-- 完全不同,所以各自一張表:
--   * mcp_clients —— App 的登記(名字、回呼網址)。登記是公開的(規格要求),
--     沒有人允許過的登記一週後在下一次登記時順手清掉。
--   * mcp_grants  —— 「這個 App 可以用這位管理員的身分操作」,也就是設定頁上
--     列出的一條連線。撤銷 = 刪這一列,底下的碼與權杖一起刪(應用層明確刪,
--     外鍵的 cascade 是第二道)。同一個 App 同一位管理員只有一列:重新連線是
--     更新權限,不是多一條。
--   * mcp_codes   —— 授權碼,幾分鐘內一次性使用(取用 = DELETE … RETURNING)。
--   * mcp_tokens  —— access(一小時)與 refresh(30 天,每用一次換一把新的)。
--
-- ── 只存雜湊 ────────────────────────────────────────────────────────────────
--
-- 碼、權杖、App 的 client secret 一律只存 SHA-256(raw) 的 hex(同 sessions 與
-- api_tokens 的手法);原值只在發出的那一次回應裡出現。D1 外洩拿不到任何能用的
-- 憑證。
--
-- ── scope ──────────────────────────────────────────────────────────────────
--
-- 'read' 或 'write'(write 含 read)。刻意只有兩級:管理員在同意畫面上選的就是
-- 「只能查看 / 可以查看與修改」,權限住在 grant 上而不是權杖上 —— 重新連線改了
-- 權限,手上的權杖立即跟著變。
--
-- ── agent_audit.app ─────────────────────────────────────────────────────────
--
-- 經 MCP 執行的工具也記進 agent_audit(source = 'mcp'),`app` 記那一刻 App 的
-- 名字(反正規化:連線被撤銷、登記被清掉之後,稽核列仍然讀得懂是誰)。面板內
-- 的兩個來源('chat' / 'execute')這一欄是 NULL。

CREATE TABLE `mcp_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`secret_hash` text,
	`created_at` integer NOT NULL
);

CREATE INDEX `mcp_clients_created_idx` ON `mcp_clients` (`created_at`);

CREATE TABLE `mcp_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`resource` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `mcp_grants_client_user_idx` ON `mcp_grants` (`client_id`,`user_id`);
CREATE INDEX `mcp_grants_user_idx` ON `mcp_grants` (`user_id`);

CREATE TABLE `mcp_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_grants`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `mcp_codes_grant_idx` ON `mcp_codes` (`grant_id`);

CREATE TABLE `mcp_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_grants`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `mcp_tokens_grant_idx` ON `mcp_tokens` (`grant_id`);

ALTER TABLE `agent_audit` ADD `app` text;
