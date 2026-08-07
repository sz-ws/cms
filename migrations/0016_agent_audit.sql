-- Admin AI agent 的稽核軌跡:新表 `agent_audit`(每一次 tool 執行一列)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0015 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 停在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
--
-- 表與索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
-- 執行期契約:src/ext/agent-audit.ts。
--
-- ── 為什麼要有這張表 ────────────────────────────────────────────────────────
--
-- docs/spec-admin-agent.md §1.3 是三條不可協商的安全模型之一:「每次 tool 執行
-- (read 與 write 都記)寫入 agent_audit 表」。read 也記,不是形式主義 —— agent
-- 讀得到站上所有內容(含訪客投稿這種個資性質的資料),「AI 幫我查了什麼」與
-- 「AI 改了什麼」是同一個問題的兩半,只記後者等於預設前者無害。
--
-- ── append-only ─────────────────────────────────────────────────────────────
--
-- 只有 INSERT。應用層沒有任何 UPDATE / DELETE 路徑(src/ext/agent-audit.ts 只匯出
-- 一支寫入函式與讀取用的查詢)。稽核紀錄一旦可以被改寫,它就只是一份「目前為止
-- 沒人想動它」的日誌,而不是證據。保留策略若哪天需要,應該是一支明確的、會留下
-- 自身紀錄的清理 job,不是散在各處的 DELETE。
--
-- ── 為什麼 user_id 不是 FK ──────────────────────────────────────────────────
--
-- users(id) 上刻意**不**建外鍵:刪一個管理員不該連帶抹掉他做過什麼。email 一併
-- 反正規化存下來,正是為了讓那一列在使用者不存在之後仍然讀得懂(「誰做的」在
-- 事後只剩這個欄位回答得出來)。代價是 user_id 可能指向已不存在的列 —— 對稽核
-- 而言那不是資料完整性問題,那就是事實。
--
-- ── 欄位取捨 ────────────────────────────────────────────────────────────────
--
-- spec §1.3 要求的是 who / tool / args / result 摘要 / 成功與否 / 時間。另外多存
-- 兩欄,兩者都是「事後想知道、事後補不回來」的東西:
--   * kind  —— 這一列是 read 還是 write。tool 的 kind 由 registry 決定,而
--     registry 會隨 extension 增刪而變;三個月後回頭看,那時的 kind 已經查不到。
--   * source —— "chat"(loop 內自動執行的 read)還是 "execute"(admin 按下確認卡
--     後執行)。確認制的核心主張是「write 只發生在 execute」,而這一欄正是那句話
--     的可查證形式:agent_audit 裡不該存在 kind='write' AND source='chat' 的列。
--
-- args / result 皆為截斷後的 JSON 文字(上限見 src/ext/agent-audit.ts)。secret 類
-- setting 的值結構上進不來 —— core.settings.get 從不讀 secret 欄位(見
-- src/ext/agent-tools-core.ts 的 readSettingsSafely),所以這裡不需要、也刻意不做
-- 「事後遮罩」那種要靠每一處都不出錯才成立的防線。

CREATE TABLE IF NOT EXISTS agent_audit (
  id          TEXT PRIMARY KEY,      -- crypto.randomUUID()
  at          INTEGER NOT NULL,      -- epoch ms
  user_id     TEXT NOT NULL,         -- 刻意無 FK(見上)
  user_email  TEXT NOT NULL,         -- 反正規化:使用者被刪後仍讀得懂
  tool        TEXT NOT NULL,         -- agent tool name,如 content.gallery_item.update
  kind        TEXT NOT NULL,         -- 'read' | 'write'
  source      TEXT NOT NULL,         -- 'chat' | 'execute'
  args        TEXT NOT NULL,         -- JSON,截斷
  ok          INTEGER NOT NULL,      -- 1 = 成功,0 = 失敗(含 args 驗證未過)
  result      TEXT,                  -- 成功時的結果摘要(JSON,截斷);失敗為 NULL
  error       TEXT                   -- 失敗原因摘要(截 200 字);成功為 NULL
);

-- 唯一的掃描路徑是「最近 N 列」(面板內的折疊顯示,spec §8 問題 2 v1 拍板:
-- 先不做獨立 admin 頁)。id 是主鍵而非時間,故時間序需要自己的索引。
CREATE INDEX IF NOT EXISTS agent_audit_at_desc ON agent_audit (at DESC);
