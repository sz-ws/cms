import type { ComponentType } from "react";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import type { CoreServices } from "./services";
import type { Capability } from "./capabilities";
import { AGENT_TOOL_NAME_RE } from "./agent-tools";
import type { AgentTool } from "./agent-tools";
import type {
  DeclarativeContentType,
  DeclarativeDashboardCard,
} from "./dx/manifest";
import type { LocalizedString } from "@/lib/i18n/localized";
import { validateSettingValue } from "../lib/setting-validation";
import { rangeStartsAtOrAfter } from "./semver";

// 03 §1:Extension 型別(完整內容,欄位一字不差照 spec)。
// core-v2 §2.1 / §2.2 / §3.1:ApiCtx.services、manifest coreApi/provides、zod 驗證。

export interface ExtMigration {
  id: string; // 該 extension 內唯一,如 "0001_create_posts"
  sql: string; // 可含多個 statement,以 ";" 分隔;statement 內不得出現字面值分號
  // (trigger 等複雜 SQL 不支援);所有 CREATE TABLE/INDEX 必須帶
  // IF NOT EXISTS(重試冪等的前提)
}

export interface SettingFieldBase {
  key: string; // 存入 settings 表時為 `ext.<extId>.<key>`
  // spec-extension-i18n.md §1 #9/#10:label/description 可 localize(union;純字串
  // 全相容)。declarative interpret 透傳原始 LocalizedString(memo-safe),SettingsWorkspace
  // 於 client(admin,有 I18nProvider)以 useLocale() resolve。
  label: LocalizedString;
  description?: LocalizedString;
  default: unknown;
  /** Empty/blank values are rejected at manifest/install/settings boundaries. */
  required?: boolean;
  secret?: boolean; // true → 加密儲存、API 只寫不讀(02 §1、05 §4)
}
export type SettingField = SettingFieldBase &
  (
    | { type: "text" | "textarea" }
    | { type: "number" }
    | { type: "boolean" }
    // §1 #11:settings select 已 value/label 分離,label 可乾淨 localize。
    | { type: "select"; options: { value: string; label: LocalizedString }[] }
  );

export interface AdminPage {
  slug: string; // "" = extension 主頁;URL: /admin/ext/<extId>/<slug>
  // §1 #12:sidebar 標題可 localize;interpret 透傳原始 LocalizedString(memo-safe),
  // 於 admin layout 每 request 以 getLocale() resolve。
  title: LocalizedString; // 顯示在 sidebar
  showInMenu?: boolean; // default true
  component: ComponentType<{
    params: Record<string, string>; // 至少含 { extId }
    searchParams: Record<string, string>; // URL query(如 ?id=xxx)
  }>; // Server Component
}

export interface ApiCtx {
  user: SessionUser; // SessionUser 來自 @/lib/auth (04 §3)
  services: CoreServices; // core-v2 §2.1:scope 綁定至 extId 的核心服務
}

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // 如 "posts" 或 "posts/:id";URL: /api/ext/<extId>/<path>
  /**
   * 1.28.0:true = 免登入(匿名可呼叫)。在此之前 code extension 的 API 一律
   * requireAuth(editor+),匿名寫入只有 declarative public content type 的 POST
   * 一條路 —— 商店結帳這類「訪客就是呼叫者」的端點做不出來。
   * 安全語意:mutation 的 same-origin 檢查**照舊**(dispatcher 在 auth 之前擋);
   * rate limiting 是 handler 自己的責任(lib/rate-limit.ts 的 hitRateLimit)。
   * handler 收到的 ctx.user 是 anonymous placeholder(同 declarative public POST)。
   */
  public?: boolean;
  handler: (
    req: Request,
    params: Record<string, string>,
    ctx: ApiCtx,
  ) => Promise<Response>;
}

export interface PublicRoute {
  // 回傳 null = 不匹配,交給下一個 extension
  // 約束:segments 是免登入、外部完全可控的輸入,且每個公開 request 會跑過所有
  // enabled 模組的所有 matcher——match 必須是 O(segments) 的純字串段比較,
  // 禁止對 segments 執行 regex(ReDoS 面)或任何 I/O
  match: (segments: string[]) => Record<string, string> | null;
  component: ComponentType<{ params: Record<string, string> }>;
}

// core-v2 §2.2:code extension 可註冊替代 provider。
export interface ProviderRegistration {
  capability: Capability;
  id: string; // provider id,如 "better-upload"
  create: (services: CoreServices) => unknown; // factory
}

// spec-extension-jobs.md:extension 貢獻的 job。有 `every` = 週期性(engine 依此建
// ext_jobs 的 recurring 列);無 = 純 handler,僅供 services.jobs.schedule() 一次性
// 排程指向。執行由 src/lib/jobs.ts 的 `ext-jobs` core job 併入 runDueJobs 驅動。
export interface ExtJobRegistration {
  id: string; // ^[a-z][a-z0-9-]{0,30}$,同 extension 內唯一
  every?: number; // 分鐘,整數 ≥1;有 = 週期性;無 = 純 handler
  run: (services: CoreServices, payload: unknown, now: number) => Promise<void>;
}

export interface Extension {
  id: string; // ^[a-z][a-z0-9-]{1,30}$
  // §1 #1/#2:declarative interpret 透傳原始 LocalizedString(memo-safe);server 端
  // 消費點(dashboard extName、settings 分頁標題、extensions 列表 DTO)以 getLocale()
  // resolve。code extension 給純字串即可(string ⊂ LocalizedString)。
  name: LocalizedString;
  version: string; // semver
  coreApi: string; // core-v2 §1:相容的 CORE_API_VERSION semver range,如 "^1.0.0"
  description?: LocalizedString;
  /** admin nav / menu icon hint (lucide token or code-extension-resolved symbol name). */
  icon?: string;
  /** OG image 設定(declarative extensions only)。 */
  og?: {
    image?: {
      template: string;
      brand?: string;
    };
  };
  migrations?: ExtMigration[];
  settings?: SettingField[];
  adminPages?: AdminPage[];
  apiRoutes?: ApiRoute[];
  publicRoutes?: PublicRoute[];
  // Alpha:讓 dispatch 識別 public type(POST 跳 requireAuth);不必走 Extension 介面,
  // 直接由 interpret.tsx 從 manifest.contentTypes 衍生。
  contentTypes?: DeclarativeContentType[];
  // roadmap #16:extension 貢獻的 dashboard 卡(stat/recent)。declarative 由 interpret
  // 從 manifest.dashboardCards 直接帶入;code extension 之後也可自行設定同欄位。
  dashboardCards?: DeclarativeDashboardCard[];
  hooks?: Partial<Record<HookName, HookHandler>>;
  provides?: ProviderRegistration[]; // core-v2 §2.2:選填
  jobs?: ExtJobRegistration[]; // spec-extension-jobs.md:週期性 / 一次性任務宣告
  /**
   * 1.30.0(docs/spec-admin-agent.md §2 表格第二列):這個 extension 讓 admin agent
   * 能操作自己的動作。宣告了就自動進 agent 的 tool registry —— 裝一個 extension =
   * AI 自動會操作它,不必再改 core 一行。
   *
   * 命名空間是硬規則(defineExtension 驗、buildAgentToolRegistry 再驗一次):每個
   * name 必須以 `<extId>.` 開頭,同 settings 的 `ext.<extId>.` scoping 精神 ——
   * tool name 是 LLM 唯一的定址方式,沒有前綴就等於允許一個 extension 宣告
   * `shop.orders.verify` 去冒名另一個 extension 的動作。
   *
   * `kind:"write"` 是確認制的載體(spec §1.2),不是分類標籤:任何會寫入的動作都
   * 必須標 write,否則它會在 agent loop 內被直接執行而不經人工確認。
   */
  agentTools?: AgentTool[];
  uninstall?: ExtMigration[]; // 解除安裝時執行(如 DROP TABLE)
}

/**
 * 驗一個 extension 宣告的 agentTools —— 回傳人話問題清單(空 = 合格),不 throw。
 *
 * 為什麼回清單而不是直接 throw:兩個呼叫端要的回報方式不同 —— defineExtension 要把
 * 問題併進 zod 的 issue 列表(一次看到 manifest 的所有毛病),buildAgentToolRegistry
 * 要當場 throw。但**規則只有這一份**,兩邊不可能分叉。
 *
 * 參數型別刻意放寬成 unknown 欄位:registry 雖由 TypeScript 約束為 Extension[],
 * 仍要防禦手寫 JS / any 繞過 defineExtension 的情況(同 loader 對 coreApi 的態度)。
 */
export function agentToolIssues(
  extId: string,
  tools: readonly { name?: unknown; description?: unknown; kind?: unknown }[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const prefix = `${extId}.`;
  tools.forEach((tool, idx) => {
    const at = `agentTools[${idx}]`;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (name.length === 0) {
      issues.push(`${at}: tool name is required`);
      return;
    }
    // 形狀(至少兩段點分小寫)與 agent-tools.ts 的 registry 用同一條 regex。
    if (!AGENT_TOOL_NAME_RE.test(name)) {
      issues.push(
        `${at}: invalid tool name "${name}" (expect lowercase dot-separated segments, e.g. "${prefix}orders.list")`,
      );
    } else if (!name.startsWith(prefix)) {
      issues.push(`${at}: tool name "${name}" must start with "${prefix}"`);
    }
    if (tool.kind !== "read" && tool.kind !== "write") {
      issues.push(`${at}: kind must be "read" or "write"`);
    }
    if (
      typeof tool.description !== "string" ||
      tool.description.trim().length === 0
    ) {
      issues.push(`${at}: description must be a non-empty sentence`);
    }
    if (seen.has(name)) issues.push(`${at}: duplicate tool name "${name}"`);
    seen.add(name);
  });
  return issues;
}

// ---- zod 驗證(core-v2 §3.1:load 時驗 manifest,不再信任)----
// 只驗可靜態檢查的形狀(id/semver/route 字串);function 欄位(component/handler/create)
// 與 React 型別交給 TS 編譯期,zod 僅確認其為 function。

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
// semver / range:寬鬆比對(exact 或帶 ^ ~ >= 前綴的 x.y.z),嚴格語意由 semver.ts 負責。
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RANGE_RE = /^(\^|~|>=)?\d+\.\d+\.\d+$/;

const fn = z.custom<(...a: never[]) => unknown>(
  (v) => typeof v === "function",
  { message: "expected function" },
);

const apiRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // path:segment 字串,允許 :param;禁止 regex 特殊語意(僅 [a-z0-9:/-])。
  path: z
    .string()
    .min(1)
    .regex(/^[a-z0-9:/-]+$/i, "invalid route path"),
  public: z.boolean().optional(), // 1.28.0:免登入端點(見 ApiRoute.public)
  handler: fn,
});

const localizedStringSchema = z.union([
  z.string().min(1),
  z
    .object({
      en: z.string().optional(),
      "zh-Hant": z.string().optional(),
    })
    .strict()
    .refine((value) => value.en !== undefined || value["zh-Hant"] !== undefined, {
      message: "localized string requires at least one locale",
    }),
]);

// name 是 admin 列表、settings 分頁標題、dashboard 卡署名唯一的人類可讀識別;
// 空字串等於沒有名字(消費端只剩 `?? ext.id` 的機器 key 可退)。string 分支已由
// localizedStringSchema 的 .min(1) 擋住 "",物件分支則只被 refine 過「至少一鍵」——
// `{ "zh-Hant": "" }` 有鍵但沒有值,會安靜地變成沒有名字,所以在這裡補一道。
const nonEmptyLocalizedString = localizedStringSchema.refine(
  (value) =>
    typeof value === "string" ||
    Object.values(value).some((v) => typeof v === "string" && v.length > 0),
  { message: "localized string requires at least one non-empty locale" },
);

const settingSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "invalid setting key"),
    label: localizedStringSchema,
    description: localizedStringSchema.optional(),
    default: z.unknown(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    type: z.enum(["text", "textarea", "number", "boolean", "select"]),
    options: z
      .array(
        z.object({ value: z.string(), label: localizedStringSchema }).strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((setting, ctx) => {
    if (setting.type === "select") {
      const values = (setting.options ?? []).map((option) => option.value);
      if (values.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "select setting requires options",
          path: ["options"],
        });
      } else if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          message: "select setting option values must be unique",
          path: ["options"],
        });
      }
    } else if (setting.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "options are only valid for select settings",
        path: ["options"],
      });
    }
    if (setting.secret && setting.default !== "") {
      ctx.addIssue({
        code: "custom",
        message: "secret setting default must be empty",
        path: ["default"],
      });
    }
    const error = validateSettingValue(
      { ...setting, required: false },
      setting.default,
    );
    if (error) {
      ctx.addIssue({
        code: "custom",
        message: `invalid default for ${setting.type} setting: ${error}`,
        path: ["default"],
      });
    }
  });

const migrationSchema = z.object({
  id: z.string().min(1),
  sql: z.string().min(1),
});

const adminPageSchema = z.object({
  slug: z.string(),
  title: localizedStringSchema,
  showInMenu: z.boolean().optional(),
  component: fn,
});

const publicRouteSchema = z.object({
  match: fn,
  component: fn,
});

// spec-extension-jobs.md:job id 規則比 extension id 寬(允許單字元)。
const JOB_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const extJobSchema = z.object({
  id: z.string().regex(JOB_ID_RE, "invalid job id"),
  every: z.number().int().min(1).optional(),
  run: fn,
});
// 同 extension 內 id 重複 → fail-loud(同 registry 重複 provider 慣例)。
const jobsSchema = z
  .array(extJobSchema)
  .refine((jobs) => new Set(jobs.map((j) => j.id)).size === jobs.length, {
    message: "duplicate job id within extension",
  })
  .optional();

// 1.30.0:agentTools 的**結構**驗證(欄位型別 / execute 是 function / schema 是 zod)。
// 命名空間與重複名走 agentToolIssues(見上),因為那條規則 buildAgentToolRegistry 也要用。
// schema 只確認「有 safeParse」,同 fn 只確認「是 function」的精神 —— 深驗一個 zod
// 物件既做不到也沒必要,args 的真正把關在 invokeAgentTool。
const zodSchemaLike = z.custom<z.ZodType>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === "function",
  { message: "expected a zod schema" },
);

const agentToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["read", "write"]),
  schema: zodSchemaLike,
  execute: fn,
  // 1.31.0:確認卡的人話摘要。列出來而不是靠 z.object() 預設放行未知鍵 —— 這份
  // schema 是「extension 宣告的 agentTools 長什麼樣」的單一來源,一個沒寫在這裡
  // 的欄位等於沒有人保證它的型別(寫成字串也照樣通過)。
  summarize: fn.optional(),
  // 1.33.0:結果的卡片式呈現(AgentTool.display)。同 summarize 只驗「是 function」
  // —— 它的回傳值另有一道守門(agent-loop 對每次呼叫的產物跑 agentDisplaySchema),
  // 而那道守門才是真正決定畫不畫的地方。這裡只確保宣告的欄位不是一個字串。
  display: fn.optional(),
});

const manifestSchema = z
  .object({
    id: z.string().regex(ID_RE, "invalid extension id"),
    // spec-extension-i18n.md §1 #1/#2:頂層 name/description 與 label/title 一樣是
    // LocalizedString。Extension 介面自 1.17.0 起就這樣宣告了,但這裡的 zod 還停在
    // 純 z.string() —— 於是寫物件形式的 code extension 過得了 tsc、卻要等到
    // `next build` 的 collecting page data 才在一個看似無關的路由上炸開。驗證跟上
    // 型別,失敗點才會回到 defineExtension 本身。
    name: nonEmptyLocalizedString,
    version: z.string().regex(SEMVER_RE, "invalid version (expect x.y.z)"),
    coreApi: z.string().regex(RANGE_RE, "invalid coreApi range"),
    description: localizedStringSchema.optional(),
    migrations: z.array(migrationSchema).optional(),
    uninstall: z.array(migrationSchema).optional(),
    settings: z.array(settingSchema).optional(),
    adminPages: z.array(adminPageSchema).optional(),
    publicRoutes: z.array(publicRouteSchema).optional(),
    apiRoutes: z.array(apiRouteSchema).optional(),
    provides: z
      .array(
        z.object({
          capability: z.string().min(1),
          id: z.string().min(1),
          create: fn,
        }),
      )
      .optional(),
    jobs: jobsSchema,
    agentTools: z.array(agentToolSchema).optional(),
  })
  // 其餘欄位(migrations/settings/adminPages/publicRoutes/hooks/uninstall)含 React
  // 型別與 function,不在 zod 深驗範圍,passthrough 保留。
  .passthrough()
  .superRefine((ext, ctx) => {
    const duplicate = (
      values: readonly string[],
      path: string,
      label: string,
    ) => {
      const seen = new Set<string>();
      values.forEach((value, idx) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate ${label} "${value}"`,
            path: [path, idx],
          });
        }
        seen.add(value);
      });
    };

    duplicate((ext.settings ?? []).map((item) => item.key), "settings", "setting key");
    duplicate((ext.migrations ?? []).map((item) => item.id), "migrations", "migration id");
    duplicate((ext.uninstall ?? []).map((item) => item.id), "uninstall", "uninstall migration id");
    duplicate((ext.adminPages ?? []).map((item) => item.slug), "adminPages", "admin page slug");
    duplicate(
      (ext.apiRoutes ?? []).map((item) => `${item.method} ${item.path}`),
      "apiRoutes",
      "API route",
    );
    duplicate(
      (ext.provides ?? []).map((item) => `${item.capability}:${item.id}`),
      "provides",
      "provider registration",
    );
    if (
      (ext.settings ?? []).some((setting) => setting.required) &&
      !rangeStartsAtOrAfter(ext.coreApi, "1.18.0")
    ) {
      ctx.addIssue({
        code: "custom",
        message: 'settings[].required requires coreApi "^1.18.0" or newer',
        path: ["coreApi"],
      });
    }
    // 1.30.0:agentTools 的命名空間 / 重複名(規則見 agentToolIssues)。
    for (const message of agentToolIssues(ext.id, ext.agentTools ?? [])) {
      ctx.addIssue({ code: "custom", message, path: ["agentTools"] });
    }
    // manifestSchema 對 code extension 是 .passthrough() —— 舊 core 不會拒收帶
    // agentTools 的 manifest,只會**安靜地**把它當成不存在的欄位忽略(agent 面板
    // 少了幾個 tool,沒有任何錯誤訊息)。所以這裡把「宣告了就必須標版號」變成硬
    // 規則,同 settings[].required 對 1.18.0 的前例。
    if (
      (ext.agentTools ?? []).length > 0 &&
      !rangeStartsAtOrAfter(ext.coreApi, "1.30.0")
    ) {
      ctx.addIssue({
        code: "custom",
        message: 'agentTools requires coreApi "^1.30.0" or newer',
        path: ["coreApi"],
      });
    }
  });

export function defineExtension(ext: Extension): Extension {
  const result = manifestSchema.safeParse(ext);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`[defineExtension] invalid manifest "${ext.id}": ${issues}`);
  }
  return ext;
}

// ---- Hooks ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookHandler = (...args: any[]) => Promise<any> | any;

export type HookName =
  // actions(通知,無回傳值)
  | "ext:enabled" // (extId: string)
  | "ext:disabled" // (extId: string)
  | "user:created" // (user: { id; email; name; role })
  | "settings:saved" // (keys: string[])
  | "storage:uploaded" // ({ key, size, contentType })
  // core-v2 §3.3:content 生命週期(payload { type, id, data })
  | "content:created"
  | "content:updated"
  | "content:deleted"
  // core-v2 §2.5:unified callback ingress 觸發的示例 hooks。provider 的 handleCallback
  // 可觸發任何 hook;此處註冊至少這兩個讓 payment / extraction 回呼流程可運作。
  // 1.28.0 起 payload 增帶 orderNo(payment-kit 的結算路徑統一填入;第三方
  // provider 不填仍合法)—— 消費端(commerce)靠它把付款對回自己的訂單,
  // 不必解讀各 gateway 形狀不一的 event。
  | "payment:succeeded" // (payload: { providerId; orderNo?; event: unknown })
  | "extraction:completed" // (payload: { providerId; event: unknown })
  // filters(第一個參數是值,回傳修改後的值)
  | "filter:adminMenu" // (items: AdminMenuItem[]) => AdminMenuItem[]
  | "filter:publicHome" // (component: ComponentType | null) => ComponentType | null
  // 1.19.0:公開站外框。由 src/app/(public)/layout.tsx 消費,套在所有公開路由外層
  // (含首頁與 [...slug])。預設 null = 不渲染,新站就是「只有內容、沒有外框」。
  // 這兩個 filter 存在的意義:讓站台自訂頁首頁尾**不必改 core 檔案** —— 客戶站與
  // 正本的分歧維持在零,日後 merge 上游修正才不會衝突。
  | "filter:publicHeader" // (component: ComponentType | null) => ComponentType | null
  | "filter:publicFooter" // (component: ComponentType | null) => ComponentType | null
  // 1.24.0:公開站的浮層插槽 —— 不佔版位、疊在頁面上的東西(購買通知、cookie
  // 橫幅、回到頂端、客服泡泡)。
  //
  // 為什麼不叫 extension 去接 publicFooter 就好:那兩個 filter 的語意是「取代」,
  // 而實務上頁尾 extension 幾乎都寫成 `() => MyFooter`,直接無視傳進來的值。於是
  // 「誰先註冊」決定了浮層是否存活 —— 一個安裝順序造成的靜默消失。所以浮層自己
  // 一個插槽,而且值是**陣列**:約定俗成是 `(w) => [...w, MyWidget]`,append 沒有
  // 順序風險,N 個 extension 可以共存。
  //
  // core 對浮層不做任何包裝(不加容器、不給 class):每個 widget 自己 `fixed`
  // 自己的角落與 z-index。core 一旦加了外框,就等於替所有 widget 決定了堆疊脈絡。
  | "filter:publicWidgets"; // (widgets: ComponentType[]) => ComponentType[]
// v1 刻意不含 head/meta 注入 filter(App Router 的 <head> 管理方式不同,留待未來)

export interface AdminMenuItem {
  href: string;
  title: string;
  order?: number;
}
