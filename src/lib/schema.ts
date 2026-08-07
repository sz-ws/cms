import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { isNotNull } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  // spec-login-providers.md §3:新增 "guest"(訪客)角色 —— TS-level enum text 欄,
  // 無需 DDL。開放註冊的第三方登入自動建帳一律給 guest(權限最低,升權由 admin 手動)。
  role: text("role", { enum: ["admin", "editor", "guest"] }).notNull().default("editor"),
  createdAt: integer("created_at").notNull(),
  // migrations/0008_user_avatar.sql(手寫,見該檔頭註解):使用者頭像的 storage key
  // (lib/storage.ts scope "avatars")。NULL = 未設定頭像。序列化路徑經
  // /api/files/<key>(見 src/app/api/files/[[...key]]/route.ts)。
  avatarKey: text("avatar_key"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// roadmap #1:Public Content API 的 inbound bearer token。raw token 只在建立當下
// 回傳一次,永不落庫;D1 只存 SHA-256(raw) 的 hex(token_hash,與 session 同手法)。
// prefix = raw token 前 11 字元("sk_" + 8),供 UI 辨識(如 "sk_ab12cd34")。
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  scope: text("scope").notNull().default("read"),
  // 每次成功驗證時更新(為省 D1 寫入,只在距上次 > 60s 才更新)。
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull(),
});

// L1 §1:WebAuthn / passkey 憑證。id = credential id(base64url,lib 給什麼存什麼)。
// public_key = base64url 編碼的 COSE public key bytes;counter 由 lib 回的 newCounter
// 直接寫回(不做 counter 回退硬拒,見 src/lib/passkey.ts 註解)。
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    // JSON array 字串,如 ["internal","hybrid"];nullable。
    transports: text("transports"),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("passkeys_user").on(t.userId)],
);

// L1 §1:WebAuthn challenge 一次性存放。id = challenge(base64url)。
// 單次使用:verify 以「條件式 DELETE WHERE id=? AND expires_at>now」取走,
// meta.changes===0 → 401(過期/重放同路)。
export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["register", "auth"] }).notNull(),
  // register 時填 user_id;auth 為 usernameless 故 NULL。
  userId: text("user_id"),
  expiresAt: integer("expires_at").notNull(),
});

// spec-login-providers.md §2:第三方登入身分 ↔ user 列的綁定。手寫 migration
// (migrations/0009_login_identities.sql,照 0006–0008 precedent,不動 drizzle
// journal/meta)——此處僅 model 欄位供 query builder 使用;唯一/一般索引
// (user_identities_provider_sub / user_identities_user)由該 migration 的原生
// SQL 建立,不在此重複宣告。
// id = crypto.randomUUID();provider = declarative extension id(如 "google-login");
// provider_user_id = OIDC sub;display = provider 回的 email 或 name(僅 UI 顯示)。
export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    display: text("display"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [
    uniqueIndex("user_identities_provider_sub").on(t.provider, t.providerUserId),
    index("user_identities_user").on(t.userId),
  ],
);

// spec-login-providers.md §2:一次性 OAuth state 存放(照 webauthn_challenges
// precedent)。id = state(random 32 bytes hex);payload = JSON
// {provider, nonce, verifier, mode, userId?, next?};單次使用:callback 以
// 「條件式 DELETE WHERE id=? AND expires_at>now」取走,meta.changes===0 → 拒絕
// (過期/重放同路)。手寫 migration 建表(0009),此處僅 model 欄位。
export const oauthStates = sqliteTable("oauth_states", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const extensions = sqliteTable("extensions", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  version: text("version").notNull(),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const extMigrations = sqliteTable("ext_migrations", {
  id: text("id").primaryKey(),
  extId: text("ext_id").notNull(),
  appliedAt: integer("applied_at").notNull(),
});

// core-v2 §2.4:default ContentProvider 的 JSON document 儲存(免 runtime DDL)。
// data 為 JSON 字串;filter/sort 用 json_extract(data,'$.field')。unknown key 保留不動。
//
// migrations/0011(手寫,見該檔頭):多語內容 = 一列一個 (entry, locale)。同批 migration
// 亦重建了 content_fts 虛擬表(加 locale UNINDEXED 欄)—— FTS5 在 drizzle 無法建模
//(見 migrations/0005 檔頭),此處記錄以免那個 raw-SQL 構造失聯。
export const contents = sqliteTable(
  "contents",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // "<extId>.<typeName>",如 "gallery.item"
    // migrations/0011:BCP-47 locale tag,canonical token 為 "en" / "zh-Hant"
    //(src/lib/i18n/index.ts 的 Locale;大小寫是 zh-Hant)。建立後不可變更 ——
    // 改 locale = 刪除後重建(見 content-provider.ts 的 update())。
    locale: text("locale").notNull().default("en"),
    // migrations/0011:sibling 譯本連結。group 第一列 = 自己的 id,譯本原樣複製此值。
    // 寫入路徑一律明確給值(create 以 `?? id` 保底),DEFAULT '' 僅為 SQLite 的
    // ADD COLUMN NOT NULL 需要常數預設值,app 端不可達。
    translationGroup: text("translation_group").notNull().default(""),
    slug: text("slug"),
    status: text("status").notNull().default("draft"),
    // jobs §publish-due:排程發佈時戳(epoch ms)。非 NULL 且 <= now 的 draft 會被
    // core job 轉為 published(轉換後清回 NULL)。ROW 欄位(與 status 同層),不入
    // JSON data。每個 locale 列各自獨立排程 —— 刻意如此(en 先發、zh-Hant 後發)。
    publishAt: integer("publish_at"),
    data: text("data").notNull(), // JSON
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // slug 於同 (type, locale) 內唯一(僅 slug 非 NULL 時);partial unique index。
    // 同 slug 跨 locale 合法(/about 的 en 與 zh-Hant 共用),不同 locale 用不同 slug
    // 亦合法(/about vs /關於)—— 兩種雙語慣例皆可,schema 不偏袒。
    uniqueIndex("contents_type_locale_slug")
      .on(t.type, t.locale, t.slug)
      .where(isNotNull(t.slug)),
    // 完整性不變量:一個 translation group 在同一 locale 至多一列。
    uniqueIndex("contents_group_locale").on(t.translationGroup, t.locale),
    // locale-scoped collection/list 排序。
    index("contents_type_locale_updated").on(t.type, t.locale, t.updatedAt),
    // locale-agnostic 掃描(seo-cache / dashboard aggregate / widget trend)保留 ——
    // (type, locale, updated_at) 的前綴不涵蓋 (type, updated_at)。
    index("contents_type_updated").on(t.type, t.updatedAt),
  ],
);

// 內容版本歷史(migrations/0010_content_revisions.sql,手寫,照 0006–0009 precedent)。
// 每次有意義的寫入在此留一列**完整快照**(非 diff):slug/status/publishAt/data 合起來
// 就是那一刻可還原的全部 row 狀態(id/type/createdAt 不可變,故不入快照)。取捨理由、
// 保留策略與 actor 語意寫在該 migration 檔頭;runtime 契約見 src/lib/revisions.ts。
//
// 與 extJobs(0007)不同,這裡的索引**同時**宣告於此與 migration 原生 SQL(同名同欄),
// 不讓 schema.ts 再度變成資料庫的不完整描述。
export const contentRevisions = sqliteTable(
  "content_revisions",
  {
    id: text("id").primaryKey(), // nanoid()
    contentId: text("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "<extId>.<typeName>"
    slug: text("slug"),
    status: text("status").notNull(), // 'draft' | 'published'
    publishAt: integer("publish_at"),
    data: text("data").notNull(), // JSON 快照
    // 寫入當下的 session user;匿名 public create / 無 request session → NULL。
    // 使用者被刪 → SET NULL(歷史留著,歸屬掉;UI 查無使用者就整欄不渲染)。
    actorId: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason", {
      enum: ["create", "update", "restore"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("content_revisions_content").on(t.contentId, t.createdAt)],
);

// core-v2 §3.2:declarative extension —— 儲存於 D1 的驗證後 manifest,request 時由 core 解讀。
export const declarativeExtensions = sqliteTable("declarative_extensions", {
  id: text("id").primaryKey(), // 與 code extension 相同 id 規則
  manifest: text("manifest").notNull(), // 完整驗證後 JSON
  version: text("version").notNull(),
  enabled: integer("enabled").notNull().default(1),
  source: text("source"), // 來源 registry URL
  // 1.8.0:co-located style.css(已經 validateStylesheet 驗證的原文)。NULL = 無 sheet
  // (或 update 時 manifest 移除了 stylesheet 欄 → 清回 NULL)。render 時 scoped 注入。
  stylesheet: text("stylesheet"),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// spec-extension-jobs.md:extension 貢獻的週期性 / 一次性任務(engine 見
// src/lib/jobs.ts 的 `ext-jobs` core job)。手寫 migration(migrations/0007_ext_jobs.sql,
// 照 0006 precedent,不動 drizzle journal/meta)——此處僅 model 欄位供 query builder
// 使用;`ext_jobs_due` 一般索引與 `ext_jobs_recurring` partial unique 索引皆由該
// migration 的原生 SQL 建立,不在此重複宣告。
export const extJobs = sqliteTable("ext_jobs", {
  id: text("id").primaryKey(), // crypto.randomUUID()
  extId: text("ext_id").notNull(),
  jobId: text("job_id").notNull(),
  kind: text("kind", { enum: ["once", "recurring"] }).notNull(),
  runAt: integer("run_at").notNull(), // 下次到期 epoch ms
  payload: text("payload"), // JSON;僅 once 使用
  attempts: integer("attempts").notNull().default(0), // 僅 once 使用
  status: text("status", { enum: ["pending", "dead"] })
    .notNull()
    .default("pending"), // dead 僅 once 會到達
  lastRun: integer("last_run"), // 上次實際執行 epoch ms(觀測)
  lastError: text("last_error"), // 上次失敗訊息(觀測;成功清 NULL)
  createdAt: integer("created_at").notNull(),
});

// 公開表單收件語意(migrations/0014_content_submissions.sql,手寫,照 0006–0010 precedent)。
// 「別人寄給你的訊息」與「等著發佈的內容」是兩件事;後者住 contents.status,前者住這張
// 側表。**contents 一欄未動、一個索引未改** —— 理由(併行工作 + status 的三個既有語意
// 必須原封不動)寫在該 migration 檔頭,runtime 契約見 src/lib/submissions.ts。
//
// 沒有列 = 未讀:舊站台既有的 contact 提交不需要任何 backfill 就能被收件匣正確讀出。
// ON DELETE CASCADE 讓既有的 schedule[] deleteOlderThan 保留策略原樣繼續生效
// (內容被清掉時收件紀錄跟著走,不留孤兒、不必另寫第二支清理任務)。
//
// 索引與 migration 原生 SQL **同名同欄**(不重蹈 0007 只寫在 SQL 的漂移)。
export const contentSubmissions = sqliteTable(
  "content_submissions",
  {
    // 一列內容最多一筆收件紀錄,故直接以 content_id 當主鍵。
    contentId: text("content_id")
      .primaryKey()
      .references(() => contents.id, { onDelete: "cascade" }),
    // 自 contents.type 反正規化("<extId>.<typeName>");寫入後不再變更。
    type: text("type").notNull(),
    state: text("state", { enum: ["unread", "read", "archived"] })
      .notNull()
      .default("unread"),
    // 回覆時戳。刻意**不是**第四個狀態:回覆與歸檔正交,壓成單一狀態機會把
    // 「到底有沒有人回這個人」這筆紀錄弄丟。NULL = 尚未記錄回覆。
    repliedAt: integer("replied_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("content_submissions_type_state").on(t.type, t.state)],
);

// D1 用量歷史(migrations/0015_storage_history.sql,手寫,照 0006–0014 precedent)。
// 每張被追蹤的表一列(name = SQLite 表名),由該 migration 建立的 12 個 AFTER
// INSERT / DELETE / UPDATE trigger 即時維護 —— 本表**只被讀**,除了那些 trigger
// 與 migration 的一次性回填之外沒有任何應用層寫入路徑。
//
// 為什麼需要:D1 每個 database 有硬上限(Free 500 MB / Paid 10 GB,不可調升),
// 且沒有 VACUUM —— 刪除不會把空間還回來,撞牆後只能 export → 重建 → import。
// 為什麼是 trigger 而不是定期全表掃:D1 按 rows read 計費,`SELECT count(*)` /
// `sum(length(...))` 掃整個 contents 是拿計費額度換一個數字。完整取捨(含 bytes
// 的定義與三個已知落差)寫在 migration 檔頭;讀取端是 src/lib/jobs.ts 的
// `storage-probe` core job,它只讀這張永遠 4 列的小表。
//
// trigger 是 raw-SQL-only 構造(drizzle 無法建模,同 content_fts 的處境),故
// **改動本表欄位時必須同步改那 12 個 trigger**,否則計數器會安靜地漂移。
// 本表沒有索引(單一 PK)。
export const storageHistory = sqliteTable("storage_history", {
  // 探測時間 epoch ms,同時是主鍵(一毫秒一列足矣)。
  at: integer("at").primaryKey(),
  // D1 每次查詢 meta 都回的 `size_after` —— **真實**資料庫大小(byte)。
  // 不是估算:這是 Cloudflare 自己用的數字,免費、零設定。
  sizeAfter: integer("size_after").notNull(),
  // 探測查詢自身的 rows_read(觀測用,證明這支 job 幾乎不花錢)。
  rowsRead: integer("rows_read"),
  // 保留欄:未來標記「歸檔後」「清理後」等事件,讓歷史看得出因果。
  note: text("note"),
});

// Admin AI agent 稽核軌跡(migrations/0016_agent_audit.sql,手寫,照 0006–0015
// precedent)。docs/spec-admin-agent.md §1.3:每一次 agent tool 執行(read 與 write
// 都記)一列。**append-only** —— 應用層只有 INSERT,沒有 UPDATE/DELETE 路徑
// (執行期契約見 src/ext/agent-audit.ts)。
//
// user_id 刻意無 FK:刪一個管理員不該連帶抹掉他做過什麼;user_email 反正規化存下
// 來,是為了讓那一列在使用者不存在之後仍讀得懂。完整取捨寫在 migration 檔頭。
export const agentAudit = sqliteTable(
  "agent_audit",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    // 無 .references():見上。
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    tool: text("tool").notNull(),
    kind: text("kind", { enum: ["read", "write"] }).notNull(),
    // "chat" = loop 內自動執行的 read;"execute" = admin 按下確認卡後執行。
    // 確認制的可查證形式:不該存在 kind='write' AND source='chat' 的列。
    source: text("source", { enum: ["chat", "execute"] }).notNull(),
    args: text("args").notNull(),
    // 0/1(SQLite 無 boolean)。失敗含「args 未過 schema」。
    ok: integer("ok").notNull(),
    result: text("result"),
    error: text("error"),
  },
  // 唯一的掃描路徑是「最近 N 列」。migration 的 SQL 建的是 `(at DESC)`;drizzle 的
  // index builder 型別在本版不接受欄位的排序方向,故此處只宣告欄位 —— 名稱與欄位
  // 一致即足夠(db:generate 已停用,schema.ts 是描述不是產生器的輸入)。
  (t) => [index("agent_audit_at_desc").on(t.at)],
);

