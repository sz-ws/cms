import { cache } from "react";
import { db } from "./db";
import { settings } from "./schema";
import { getEnv, getDB } from "./cf";
import { DEFAULT_INSIGHT_CONFIG } from "./dashboard-insights-config";
import { decryptSecretWithKey, encryptSecretWithKey } from "./secret-envelope";

import type { LocalizedString } from "./i18n/localized";
import type { BatchItem } from "drizzle-orm/batch";

// SettingField 型別(03 §1)。Phase 4 的 src/ext/types.ts 會 re-export 同一形狀;
// 為讓 Phase 3 不依賴尚未建立的 ext 模組,型別在此獨立定義(欄位一字不差照 03 §1)。
// spec-extension-i18n.md §1 #9–#11:label/description/option.label 可 localize
// (union;CORE_SETTINGS 的純字串全相容)。SettingsWorkspace 以 useLocale() resolve。
export interface SettingFieldBase {
  key: string;
  label: LocalizedString;
  description?: LocalizedString;
  default: unknown;
  /** Empty/blank values are rejected by the shared server-side validator. */
  required?: boolean;
  secret?: boolean;
  /**
   * 顯示分組(settings 頁一組一張卡)。設定頁的卡片完全由此欄位推導:任何
   * group id 都會長出自己的卡,不必另外登記;省略 → 落到
   * DEFAULT_SETTING_GROUP("general")。卡片順序與標題/說明取自
   * src/lib/settings-ui.ts 的 SETTING_GROUPS(未登記的 group 排在最後,
   * 標題由 id 推導)。extension settings 不分組(單卡),此欄位對其無效。
   */
  group?: string;
}
export type SettingField = SettingFieldBase &
  (
    | { type: "text" | "textarea" }
    | { type: "number" }
    | { type: "boolean" }
    | { type: "select"; options: { value: string; label: LocalizedString }[] }
  );

/**
 * 內容的預設語言(migrations/0011)。與 core.locale(管理介面語言)刻意分離 ——
 * 詳見 CORE_SETTINGS 內 core.content.defaultLocale 的註解。
 *
 * 這個常數也是「讀不到設定時」的保底值,故同時被 content-provider 的
 * update()(既有列缺 locale 的極端情形)與 index 路徑使用。
 */
export const DEFAULT_CONTENT_LOCALE = "en";

// 密碼 work factor 與 dummy hash 是 auth.ts 的單一 profile；這個 key 仍登記在
// CORE_SETTINGS，讓設定白名單、匯出遮罩與 runtime cache 都有同一個真相來源。
// 它不可由通用 PUT /api/settings 改寫，只能由校準路由原子地寫入完整 profile。
export const PASSWORD_HASHING_SETTING = "core.auth.passwordHashing";

/** 站台的內容預設語言;未設定 → DEFAULT_CONTENT_LOCALE。 */
export async function getDefaultContentLocale(): Promise<string> {
  const v = await getSetting<string>("core.content.defaultLocale");
  return typeof v === "string" && v.trim().length > 0
    ? v.trim()
    : DEFAULT_CONTENT_LOCALE;
}

// ---- Core settings 定義(05 §3)----
// Key 慣例:CORE_SETTINGS 的 key 寫「完整 key」(含 core. 前綴,直接等於 D1 key)。
// 所以 core section 的 keyPrefix=""。

export const CORE_SETTINGS: SettingField[] = [
  {
    key: "core.locale",
    group: "general",
    label: "Admin language",
    type: "select",
    options: [
      { value: "en", label: "English" },
      { value: "zh-Hant", label: "繁體中文" },
    ],
    default: "en",
  },
  {
    // migrations/0011:**內容**的預設語言,與上面的 core.locale(管理介面語言)
    // 刻意分開。合併成一個會造成:管理員把自己的後台切成英文,匿名訪客看到的
    // 內容也跟著變。新內容未指定 locale 時套用此值;既有內容不受影響
    //(locale 建立後不可變更)。
    key: "core.content.defaultLocale",
    group: "general",
    label: "Default content language",
    description:
      "New content is created in this language unless a locale is given. Separate from the admin interface language above.",
    type: "select",
    options: [
      { value: "en", label: "English" },
      { value: "zh-Hant", label: "繁體中文" },
    ],
    default: DEFAULT_CONTENT_LOCALE,
  },
  {
    key: "core.siteTitle",
    group: "general",
    label: "Site Title",
    type: "text",
    default: "My Site",
  },
  {
    key: "core.siteDescription",
    group: "general",
    label: "Site Description",
    type: "textarea",
    default: "",
  },
  {
    key: "core.brandLogo",
    group: "general",
    label: "Brand logo URL",
    description:
      "Shown top-left in the admin sidebar. Upload an image to the Media Library and paste its file URL here; empty falls back to the default mark.",
    type: "text",
    default: "",
  },
  {
    key: "core.siteUrl",
    group: "general",
    label: "Site URL",
    type: "text",
    default: "",
  },
  {
    key: "core.seo.robots",
    group: "seo",
    label: "Publish robots.txt",
    description:
      "Serves /robots.txt for crawlers. Off disallows the entire site (Disallow: /). Uses core.siteUrl for absolute URLs when set, otherwise falls back to the request origin. Setting changes take up to 5 minutes to apply (isolate-level cache).",
    type: "boolean",
    default: true,
  },
  {
    key: "core.seo.sitemap",
    group: "seo",
    label: "Publish sitemap.xml",
    description:
      "Serves /sitemap.xml listing published detail pages and list routes declared by enabled declarative extensions. Setting changes take up to 5 minutes to apply (isolate-level cache).",
    type: "boolean",
    default: true,
  },
  {
    key: "core.seo.rss",
    group: "seo",
    label: "Publish RSS feed",
    description:
      "Serves /feed.xml with the 50 most recently updated published entries. Setting changes take up to 5 minutes to apply (isolate-level cache).",
    type: "boolean",
    default: true,
  },
  {
    key: "core.emailFrom",
    group: "email",
    label: "Email from address",
    description:
      'Sender for all outgoing mail, e.g. "Acme <noreply@yourdomain.com>". The domain must be verified with the email provider.',
    type: "text",
    default: "",
  },
  {
    key: "core.resendApiKey",
    group: "email",
    label: "Resend API key",
    description:
      "Enables the built-in email provider (email:send capability). Create a key at resend.com; stored encrypted.",
    type: "text",
    secret: true,
    default: "",
  },
  {
    key: "core.notifyEmail",
    group: "email",
    label: "Notification email",
    description:
      'Recipient for content type "notify on create" submissions (declarative contentTypes[].notifyOnCreate). Empty disables the feature.',
    type: "text",
    default: "",
  },
  {
    key: "core.ai.mode",
    group: "ai",
    label: "AI provider mode",
    description:
      'Enables the ai:generate capability. "off" leaves it unconfigured; openai / anthropic route through their chat/completions-style APIs; workers-ai uses the Cloudflare Workers AI binding (add it to wrangler.jsonc yourself — not managed by this setting).',
    type: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "openai", label: "OpenAI-compatible" },
      { value: "anthropic", label: "Anthropic-compatible" },
      { value: "workers-ai", label: "Workers AI" },
    ],
    default: "off",
  },
  {
    key: "core.ai.baseUrl",
    group: "ai",
    label: "AI base URL",
    description:
      'Empty uses the mode default (openai → "https://api.openai.com/v1"; anthropic → "https://api.anthropic.com"). Ignored in workers-ai mode.',
    type: "text",
    default: "",
  },
  {
    key: "core.ai.apiKey",
    group: "ai",
    label: "AI API key",
    description:
      "Required for openai / anthropic mode; not needed for workers-ai. Stored encrypted.",
    type: "text",
    secret: true,
    default: "",
  },
  {
    key: "core.ai.model",
    group: "ai",
    label: "AI model",
    description:
      'e.g. "gpt-4o-mini", "claude-haiku-4-5-20251001", or "@cf/meta/llama-3.1-8b-instruct".',
    type: "text",
    default: "",
  },
  {
    key: PASSWORD_HASHING_SETTING,
    group: "advanced",
    label: "Password hashing calibration",
    description:
      "Managed by the password hashing calibration wizard. It records the PBKDF2 work factor and its matching dummy hash together.",
    type: "textarea",
    default: "",
  },
  {
    key: "core.auth.oauthRegistration",
    group: "advanced",
    label: "OAuth open registration",
    description:
      'spec-login-providers.md §5. Controls what happens when a third-party (Google/LINE/OIDC) login has no linked identity yet. "guest" auto-creates a new account with the lowest-privilege guest role; "off" refuses login for unlinked identities (existing users must sign in with a password first, then link from the account page). Email collisions never auto-link (anti-takeover).',
    type: "select",
    options: [
      { value: "guest", label: "Auto-create guest accounts" },
      { value: "off", label: "Off (linked identities only)" },
    ],
    default: "guest",
  },
  {
    key: "core.apiSecret",
    group: "advanced",
    label: "API Secret",
    type: "text",
    secret: true,
    default: "",
    // v1 唯一的 core secret:驗證加密管線用(Phase 3 secret 驗收測此欄位)。
  },
  {
    key: "core.demoCallbackSecret",
    group: "advanced",
    label: "Demo Callback Signing Secret",
    description:
      "core-v2 §2.5 DEMO ONLY. HMAC-SHA256 signing secret for the demo `echo` callback provider (POST /api/callback/demo-callback/echo). Remove together with the demo provider once a real payment/extraction provider ships.",
    type: "text",
    secret: true, // 加密儲存;verifyCallback 讀取明文比對簽章。
    default: "",
  },
  {
    key: "core.registrySources",
    label: "Registry Sources",
    description:
      "JSON array of https base URLs used as extension registry sources (core-v2 §3.4). Fetches are restricted to exactly these values (SSRF guard).",
    type: "textarea",
    // SettingField 目前無專用陣列 type;沿用 textarea + JSON 字串(值本身仍是 JSON.stringify 的陣列,
    // 與其他 setting 相同儲存慣例),讀取端 JSON.parse 後即為 string[]。
    default: ["https://raw.githubusercontent.com/sz-ws/registry/main"],
  },
  {
    key: "core.registryTokens",
    label: "Registry Access Tokens",
    description:
      "Encrypted map of registry source URL → access token. Written only via the registry sources manager (tokens are split out of core.registrySources so they never persist in plaintext); never rendered in the generic settings form.",
    type: "text",
    secret: true, // 明文為 JSON.stringify 的 Record<url, token>;走 AES-GCM 管線。
    default: "",
  },
  {
    key: "core.dashboard.insights",
    group: "advanced",
    label: "Dashboard Insights Widgets",
    description:
      "JSON array controlling which dashboard Insights widgets are shown, their preset, and order. Written only via the dashboard edit mode; never rendered in the generic settings form.",
    type: "textarea",
    default: DEFAULT_INSIGHT_CONFIG,
  },
];

/** extension settings 的完整 key:ext.<extId>.<key>(03 §7 / 05 §3)。 */
export const extSetting = (extId: string, key: string): string =>
  `ext.${extId}.${key}`;

// ---- Secret 加密(02 §1:AES-GCM,金鑰 = Worker secret SECRETS_KEY)----

const SECRET_MASK = "•••";

// 信封本體(IV ‖ 密文 → base64)住在 ./secret-envelope —— 那是純函式模組,金鑰材料
// 當參數收。這裡只負責「金鑰從哪來」:request 生命週期內經 getEnv() 讀 SECRETS_KEY。
//
// 為什麼要拆:custom-worker.ts 的 `scheduled` handler 也要解 ext.cron.secret,但它拿到的
// 是 Cloudflare 直接傳入的 `env`,沒有 request context(getCloudflareContext() 會 throw),
// 且不能把 Next module graph 拖進 worker 入口。兩邊共用同一份信封實作 → 格式不會漂移。
// 本檔的對外函式簽章完全不變,呼叫端無感。

/** 取 Worker secret SECRETS_KEY(base64 32-byte AES-256 金鑰);缺 → fail-loud。 */
function secretsKey(): string {
  const env = getEnv() as unknown as { SECRETS_KEY?: string };
  const raw = env.SECRETS_KEY;
  if (!raw) throw new Error("SECRETS_KEY not configured");
  return raw;
}

async function encryptSecret(plaintext: string): Promise<string> {
  return encryptSecretWithKey(secretsKey(), plaintext);
}

async function decryptSecret(stored: string): Promise<string> {
  return decryptSecretWithKey(secretsKey(), stored);
}

// ---- 全表讀取(React per-request cache + stamp-based module memo)----
// settings 表小,一次 SELECT * 快取整包(05 §3)。value 一律 JSON.stringify 存 / JSON.parse 讀。
//
// 兩層快取:
//   1. React cache() —— 同一 request 內去重(一個請求裡多處 getSetting 只讀一次)。
//   2. module 級 memo,以 stamp 驗新鮮度(手法同 loader.ts 的 getExtRuntime)——
//      每個 request 用一次輕量 scalar query 對 settings 表算指紋,指紋不變就重用已 parse
//      的整包 Map,省下列傳輸 + Map 重建 + secret 判定的 JSON.parse;省的是常見的「沒改
//      過 settings」路徑(getLocale、public 首頁、幾乎每個頁面都讀 settings)。
//
// 為何不用純 TTL(seo-cache 模式):Next 把 Server Component 與 Route Handler 放在
// 不同的 module 實例圖(RSC 的 react-server 層 vs route handler 層),同 isolate 的
// 「寫入即失效」無法跨 graph 傳播(實測:PUT /api/settings 後 public 首頁仍讀到舊
// siteTitle)。純 TTL 會讓非 SEO 的 settings(siteTitle/locale/email…,無「5 分鐘生效」
// 文案承諾)出現未告知的 staleness。stamp 每 request 對 DB 現況重新指紋,任一寫入
// (bump updated_at 或改 row 數)都必然改變指紋,所有 graph/isolate 於「下一個 request」
// 立即看到新值——保住既有「即時生效」語意(非 TTL 收斂)。
//
// 為何不用 next/cache 的 unstable_cache:prod 的 D1 tag cache 每次讀都要打 revalidations
// 表(hasBeenRevalidated → SELECT ... WHERE tag IN (...)),對「單表一次讀」沒省到,還多
// 一次 R2 incremental cache get(content-cache.ts 走 unstable_cache 是因為要掛 tag 做精準
// 失效,取捨不同)。
//
// 失敗一律降級:stamp query 失敗 → 直接走全表讀(不寫 memo,無法驗新鮮度);任何一步
// throw 都往上拋(維持原 readAll 的行為),絕不因快取 plumbing 弄壞讀取路徑。

// 指紋:COUNT + MAX(updated_at)。所有寫入路徑(setSettings / setExtensionSettingsRaw、
// manager enable/uninstall、install route)都 upsert updated_at=now 或改 row 數,故任一
// mutation 必然改變此值(同 runtime-stamp.ts 的精神)。用 getDB() 直打 scalar 最省。
const SETTINGS_STAMP_SQL =
  "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m FROM settings";

let settingsMemo: { stamp: string; value: Map<string, string> } | null = null;

async function computeSettingsStamp(): Promise<string> {
  const row = await getDB()
    .prepare(SETTINGS_STAMP_SQL)
    .first<{ n: number; m: number }>();
  if (!row) return "0:0";
  return `${row.n}:${row.m}`;
}

async function loadAllSettings(): Promise<Map<string, string>> {
  const rows = await db().select().from(settings);
  return new Map(rows.map((r): [string, string] => [r.key, r.value]));
}

const readAll = cache(async (): Promise<Map<string, string>> => {
  // stamp 失敗 → null,強制走全表讀且不寫 memo(無法在下個 request 驗證新鮮度)。
  let stamp: string | null = null;
  try {
    stamp = await computeSettingsStamp();
  } catch (e) {
    console.error("[settings] stamp query failed; reading full table", e);
  }
  if (stamp !== null && settingsMemo !== null && settingsMemo.stamp === stamp) {
    return settingsMemo.value; // 命中:重用已 parse 的整包 Map。
  }
  const value = await loadAllSettings();
  if (stamp !== null) settingsMemo = { stamp, value };
  return value;
});

/**
 * 主動清 module 級 settings memo(belt-and-braces:同 graph 的寫入後立即清,讓下個
 * request 連 stamp 都不必比就重讀)。跨 graph / 跨 isolate 的正確性已由每 request 的
 * stamp 重算涵蓋,故此函式非正確性必需——與 loader.ts 的 invalidateExtRuntimeMemo 對稱。
 * 測試亦以此重置。
 */
export function invalidateSettingsCache(): void {
  settingsMemo = null;
}

/**
 * 讀單一 setting(明文;server 端內核用途)。
 * secret key 存的是密文,此處解密後回傳明文——僅供 server 端邏輯,絕不進 API 回應。
 */
export async function getSetting<T = unknown>(
  key: string,
  fallback?: T,
): Promise<T> {
  const all = await readAll();
  const raw = all.get(key);
  if (raw === undefined) return fallback as T;
  const stored = JSON.parse(raw) as unknown;
  const secretKeys = await secretKeySetAsync();
  if (secretKeys.has(key) && typeof stored === "string" && stored.length > 0) {
    return (await decryptSecret(stored)) as T;
  }
  return stored as T;
}

/**
 * upsert 多筆 + doAction("settings:saved", keys)(05 §3)。
 * secret key(由 field 定義判定)寫入前 AES-GCM 加密;空字串視為「不變更」由呼叫端過濾。
 */
export async function setSettings(
  entries: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  const keys = Object.keys(entries);
  const secretKeys = await secretKeySetAsync();
  const prepared = await prepareExtensionSettingValues(entries, secretKeys);
  const batch = keys.map((key) =>
    db()
      .insert(settings)
      .values({ key, value: prepared[key], updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: prepared[key], updatedAt: now },
      }),
  );
  if (batch.length > 0) {
    const [first, ...rest] = batch;
    await db().batch([first, ...rest] as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ]);
  }
  // 同 graph 立即失效(admin 存檔後下一個 request 讀到新值);跨 graph/isolate 靠
  // 每 request 的 stamp 重算(見 readAll 註解)。
  invalidateSettingsCache();
  // hook 分派:settings:saved(03 §1)。enabled extension 的 handler 收得到。
  try {
    const { getExtRuntime } = await import("@/ext/loader");
    const rt = await getExtRuntime();
    await rt.hooks.doAction("settings:saved", keys);
  } catch (e) {
    console.error("[settings] post-commit hook dispatch failed", e);
  }
}

/**
 * install-time 專用寫入:extension 尚未進 enabled runtime(ext:enabled 這次 request
 * 才要 fire),所以 secretKeySetAsync()(讀 rt.enabled)看不到它 —— setSettings 的
 * 自動加密判定在這個時間點必定漏判。此函式改由呼叫端(install route)直接依
 * manifest.settings[].secret 算好 secretKeys 傳入,對命中的 key 沿用同一支
 * module-private encryptSecret 加密;其餘 upsert 邏輯與 setSettings 相同
 * (onConflictDoUpdate,無 settings:saved hook —— install 已用 ext:enabled 通知)。
 */
export async function setExtensionSettingsRaw(
  entries: Record<string, unknown>,
  secretKeys: Set<string>,
): Promise<void> {
  const now = Date.now();
  const prepared = await prepareExtensionSettingValues(entries, secretKeys);
  for (const [key, json] of Object.entries(prepared)) {
    await db()
      .insert(settings)
      .values({ key, value: json, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: json, updatedAt: now },
      });
  }
  // 同 setSettings:直接寫表後失效 isolate 快取(install route 於此後仍會再失效一次,無害)。
  invalidateSettingsCache();
}

/**
 * Prepare extension setting values before an atomic install batch. Encryption
 * and serialization can fail, so callers run this before any DB mutation.
 */
export async function prepareExtensionSettingValues(
  entries: Record<string, unknown>,
  secretKeys: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const prepared: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(entries)) {
    let value = rawValue;
    if (secretKeys.has(key) && typeof value === "string") {
      value = await encryptSecret(value);
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new Error(`setting "${key}" is not JSON serializable`);
    }
    if (json === undefined) {
      throw new Error(`setting "${key}" is not JSON serializable`);
    }
    prepared[key] = json;
  }
  return prepared;
}

// ---- Secret 判定與遮罩(讀寫兩端都經由 field 定義,D1 資料不帶旗標;05 §4)----

/**
 * 允許的 setting keys(白名單):CORE_SETTINGS + 每個 enabled extension 的 settings。
 * 05 §4:allowed = new Set([...CORE_SETTINGS.map(key), ...rt.enabled.flatMap(extSetting)])。
 */
export async function allowedSettingKeys(): Promise<Set<string>> {
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  return new Set([
    ...CORE_SETTINGS.map((f) => f.key),
    ...rt.enabled.flatMap((e) =>
      (e.settings ?? []).map((f) => extSetting(e.id, f.key)),
    ),
  ]);
}

/**
 * Setting definitions keyed exactly as they are persisted/submitted. This is
 * the value-validation counterpart to `allowedSettingKeys()`; callers should
 * use both the key allowlist and each field's declared contract.
 */
export async function allowedSettingFields(): Promise<Map<string, SettingField>> {
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  const fields = new Map<string, SettingField>(CORE_SETTINGS.map((f) => [f.key, f]));
  for (const ext of rt.enabled) {
    for (const field of ext.settings ?? []) {
      fields.set(extSetting(ext.id, field.key), field);
    }
  }
  return fields;
}

/**
 * secret key 集合:CORE_SETTINGS.secret + 每個 enabled extension 宣告 secret 的 settings。
 * 讀取端遮罩、寫入端加密都靠此 field 定義(D1 資料本身不帶 secret 旗標;05 §4)。
 */
export async function secretKeySetAsync(): Promise<Set<string>> {
  const { getExtRuntime } = await import("@/ext/loader");
  const rt = await getExtRuntime();
  const keys = CORE_SETTINGS.filter((f) => f.secret).map((f) => f.key);
  for (const e of rt.enabled)
    for (const f of e.settings ?? [])
      if (f.secret) keys.push(extSetting(e.id, f.key));
  return new Set(keys);
}

/** 同步版:只含 CORE secret keys(在無 request runtime 的極少數場合可用)。 */
function coreSecretKeySet(): Set<string> {
  return new Set(CORE_SETTINGS.filter((f) => f.secret).map((f) => f.key));
}

export function isSecretKey(key: string): boolean {
  return coreSecretKeySet().has(key);
}

export const SECRET_PLACEHOLDER = SECRET_MASK;

// ---- Registry source tokens(core.registryTokens;A2 token 加密管線)----

/**
 * 讀 registry token map(url → token,明文)。僅供 server 端(registry-client
 * fetch 前查 token、settings 頁算 hasToken 旗標)——絕不進 API 回應 / client props。
 */
export async function getRegistryTokenMap(): Promise<Record<string, string>> {
  const raw = await getSetting<string>("core.registryTokens", "");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [url, token] of Object.entries(parsed)) {
      if (typeof token === "string" && token.length > 0) out[url] = token;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * core.registrySources 寫入前處理:把 source 陣列裡的 `token` 欄位拆出來,
 * 併入 core.registryTokens(secret,AES-GCM 加密儲存),registrySources 本體
 * 永不落地 token 明文。語意:
 *   - item.token 非空字串 → 設為該 url 的新 token
 *   - item.token 缺 / 空 → 沿用既有 token(前端遮罩後不回傳,空值 = 不變更)
 *   - source 從清單移除 → 其 token 一併移除
 * 回傳兩個 entries,直接交給 setSettings(registryTokens 由 secret 管線加密)。
 */
export async function splitRegistrySourceTokens(
  incoming: unknown,
): Promise<Record<string, unknown>> {
  const existing = await getRegistryTokenMap();
  const tokens: Record<string, string> = {};
  const sources: unknown[] = [];
  if (Array.isArray(incoming)) {
    for (const item of incoming) {
      if (typeof item === "string") {
        sources.push(item);
        if (existing[item]) tokens[item] = existing[item];
        continue;
      }
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { url?: unknown }).url === "string"
      ) {
        // hasToken 是 UI 顯示旗標,不落地(讀取端由 token map 重新計算)。
        const { token, hasToken, ...rest } = item as {
          url: string;
          token?: unknown;
          hasToken?: unknown;
        };
        void hasToken;
        if (typeof token === "string" && token.length > 0) {
          tokens[rest.url] = token;
        } else if (existing[rest.url]) {
          tokens[rest.url] = existing[rest.url];
        }
        sources.push(rest);
      }
    }
  }
  return {
    "core.registrySources": sources,
    "core.registryTokens": JSON.stringify(tokens),
  };
}

/** Shape guard for core.registrySources before token extraction mutates it. */
export function isValidRegistrySources(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    const validUrl = (raw: unknown): raw is string => {
      if (typeof raw !== "string") return false;
      try {
        const url = new URL(raw);
        return (
          url.protocol === "https:" &&
          url.hostname.length > 0 &&
          url.username === "" &&
          url.password === "" &&
          url.hash === ""
        );
      } catch {
        return false;
      }
    };
    if (typeof item === "string") return validUrl(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const source = item as Record<string, unknown>;
    if (!validUrl(source.url)) return false;
    return (
      (source.token === undefined || typeof source.token === "string") &&
      (source.hasToken === undefined || typeof source.hasToken === "boolean")
    );
  });
}

/**
 * 讀取面:把一份 key→明文值 map 轉為「可外洩」形式(secret key 一律 "•••")。
 * 供 settings 頁 initial props 與 GET settings 回應使用(05 §4)。
 */
export async function maskSecrets(
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const masked: Record<string, unknown> = {};
  const secretKeys = await secretKeySetAsync();
  for (const [k, v] of Object.entries(values)) {
    masked[k] = secretKeys.has(k) ? SECRET_MASK : v;
  }
  return masked;
}
