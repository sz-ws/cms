-- AI token 用量:新表 `ai_usage`(**每一次上游 LLM 呼叫一列**)。
--
-- Hand-written (NOT drizzle-kit generated),沿用 0006..0016 的體例。drizzle 的
-- journal (migrations/meta/_journal.json) 停在 0004,0005 起全部是 out-of-journal
-- 手寫檔,且 `pnpm db:generate` 已停用。`wrangler d1 migrations apply` 依檔名順序
-- 撿每一個 *.sql,並在 D1 自己的 d1_migrations 表記錄已套用者,所以本檔即足夠。
-- migration id 是 append-only 的:本檔不改任何既有檔案一個字。
--
-- 表與索引**同時**宣告於 src/lib/schema.ts(同名同欄),遵守 0014 立下的規則。
-- 執行期契約:src/ext/ai-usage.ts。
--
-- ── 為什麼要有這張表 ────────────────────────────────────────────────────────
--
-- 這個 CMS 一直在呼叫上游 LLM,卻從來沒有讀過回應裡的 usage —— 也就是說,站上
-- 唯一會產生外部變動成本的動作,是唯一沒有任何紀錄的動作。本表把它接住,讓
-- 「某個使用者在某段期間用了多少」變成一個查得出來的數字(點數制的前置條件;
-- 本批**不做**扣抵、不做上限、不做 UI)。
--
-- ── 一列 = 一次上游呼叫,不是一則訊息 ───────────────────────────────────────
--
-- agent loop 一則訊息最多打 8 次上游(docs/spec-admin-agent.md §4 的 AGENT_MAX_STEPS)。
-- 那 8 次的成本是分開發生的:每一次都帶著當時的整份 transcript 重送,input token
-- 隨步數累加。合併成一列等於把「為什麼這則訊息特別貴」這個問題的答案丟掉,而那
-- 正是事後唯一會想問的問題。要一則訊息的總和,SUM 得回來;要相反的方向,回不去。
--
-- ── append-only ─────────────────────────────────────────────────────────────
--
-- 只有 INSERT(src/ext/ai-usage.ts 只匯出一支寫入函式)。同 agent_audit 的理由:
-- 一份可以被改寫的用量紀錄,拿來當計費依據時就只是一份「目前為止沒人想動它」的
-- 數字。保留策略若哪天需要,應該是一支明確的清理 job,不是散在各處的 DELETE。
--
-- ── 為什麼 user_id 不是 FK(照 0016 的先例)────────────────────────────────
--
-- users(id) 上刻意**不**建外鍵:刪一個管理員不該連帶抹掉他花掉的額度。email 一併
-- 反正規化存下來,是為了讓那一列在使用者不存在之後仍讀得懂(「誰用的」在事後只剩
-- 這個欄位回答得出來)。代價是 user_id 可能指向已不存在的列 —— 對用量紀錄而言那
-- 不是資料完整性問題,那就是事實。
--
-- ── 為什麼 token 欄位可以是 NULL(**刻意的,不是漏了 DEFAULT 0**)────────────
--
-- NULL = 上游沒回報;0 = 上游說這次是零。兩者必須分得出來:
--   * 有些 provider / 代理就是不回 usage(workers-ai 尤其不保證),
--   * openai 的串流要主動要(stream_options.include_usage)才有,代理可能吃掉它。
-- 把「不知道」寫成 0,會讓 SUM 出來的總額看起來像一個已知的小數字,而不是一份
-- 有缺口的帳。查詢端因此可以問「有多少列是 NULL」——那是資料品質的指標,補了 0
-- 就永遠問不出來了。同理:**「打了一次但不知道用了多少」與「沒打」也必須分得
-- 出來**,所以拿不到 usage 時仍然寫一列(兩個 token 欄位為 NULL),而不是不寫。
--
-- ── 失敗的呼叫也記(ok=0)───────────────────────────────────────────────────
--
-- 一次 4xx/逾時/斷流一樣花了時間、可能一樣被上游計費(尤其逾時 —— 對面已經生成
-- 了)。只記成功的呼叫,會讓「帳單比紀錄多」變成一個查不出來的差額。
--
-- ── **絕不記內容** ──────────────────────────────────────────────────────────
--
-- 本表沒有 prompt 欄、沒有回覆欄,而且永遠不會有。用量紀錄要回答的是「多少」,
-- 不是「說了什麼」——後者是 agent_audit 的 args/result 摘要在管的,受它自己的
-- 截斷與 secret 規則約束。error 欄只存上游錯誤摘要(截 200 字,同 ai:generate 的
-- 既有慣例,絕不含 apiKey)。
--
-- ── 索引的欄位順序 ──────────────────────────────────────────────────────────
--
-- 本表存在的目的就是回答「**某個使用者**在**某段期間**用了多少」:
--
--     SELECT sum(input_tokens), sum(output_tokens) FROM ai_usage
--      WHERE user_id = ? AND at >= ? AND at < ?;
--
-- (user_id, at) 而不是 (at, user_id):SQLite 的 B-tree 索引只能在**最左連續的
-- 等值前綴**之後再吃一個範圍條件。user_id 在前 → 直接定位到那個人的區段,再在
-- 區段內用 at 做範圍掃描,讀到的列數 ≈ 答案本身的列數。反過來 (at, user_id) 則
-- 是先掃出整段期間內**所有人**的列再逐列過濾 —— 在 D1 上那是按 rows read 計費的
-- 差別,不只是快慢。
--
-- 刻意**不**另外建 (at) 單欄索引:「全站最近 N 列」這個查詢這一批沒有消費者
-- (不做 UI),而每一個索引都要在每次 INSERT 時付出寫入成本 —— 而 INSERT 正是
-- 這張表唯一的熱路徑(一則訊息最多 8 次)。要那個查詢時再加一個 migration。

CREATE TABLE IF NOT EXISTS ai_usage (
  id            TEXT PRIMARY KEY,   -- crypto.randomUUID()
  at            INTEGER NOT NULL,   -- epoch ms
  feature       TEXT NOT NULL,      -- 呼叫來源,如 'agent.chat'
  mode          TEXT,               -- 'openai' | 'anthropic' | 'workers-ai';未知為 NULL
  model         TEXT,               -- 實際使用的 model;上游沒回報為 NULL
  input_tokens  INTEGER,            -- NULL = 上游沒回報(**不是 0**,見上)
  output_tokens INTEGER,            -- 同上
  user_id       TEXT NOT NULL,      -- 刻意無 FK(見上)
  user_email    TEXT NOT NULL,      -- 反正規化:使用者被刪後仍讀得懂
  ok            INTEGER NOT NULL,   -- 1 = 這次上游呼叫成功,0 = 失敗(仍然記)
  error         TEXT                -- 失敗原因摘要(截 200 字);成功為 NULL
);

-- 見上「索引的欄位順序」:等值欄在前、範圍欄在後。
CREATE INDEX IF NOT EXISTS ai_usage_user_at ON ai_usage (user_id, at);
