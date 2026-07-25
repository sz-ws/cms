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
export const contents = sqliteTable(
  "contents",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // "<extId>.<typeName>",如 "gallery.item"
    slug: text("slug"),
    status: text("status").notNull().default("draft"),
    // jobs §publish-due:排程發佈時戳(epoch ms)。非 NULL 且 <= now 的 draft 會被
    // core job 轉為 published(轉換後清回 NULL)。ROW 欄位(與 status 同層),不入
    // JSON data。UI(publish-at 編輯)為後續任務;API 已可透過 create/update 載入。
    publishAt: integer("publish_at"),
    data: text("data").notNull(), // JSON
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // slug 於同 type 內唯一(僅 slug 非 NULL 時);partial unique index。
    uniqueIndex("contents_type_slug")
      .on(t.type, t.slug)
      .where(isNotNull(t.slug)),
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

