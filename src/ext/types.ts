import type { ComponentType } from "react";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import type { CoreServices } from "./services";
import type { Capability } from "./capabilities";
import type {
  DeclarativeContentType,
  DeclarativeDashboardCard,
} from "./dx/manifest";

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
  label: string;
  description?: string;
  default: unknown;
  secret?: boolean; // true → 加密儲存、API 只寫不讀(02 §1、05 §4)
}
export type SettingField = SettingFieldBase &
  (
    | { type: "text" | "textarea" }
    | { type: "number" }
    | { type: "boolean" }
    | { type: "select"; options: { value: string; label: string }[] }
  );

export interface AdminPage {
  slug: string; // "" = extension 主頁;URL: /admin/ext/<extId>/<slug>
  title: string; // 顯示在 sidebar
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
  name: string;
  version: string; // semver
  coreApi: string; // core-v2 §1:相容的 CORE_API_VERSION semver range,如 "^1.0.0"
  description?: string;
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
  uninstall?: ExtMigration[]; // 解除安裝時執行(如 DROP TABLE)
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
  handler: fn,
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

const manifestSchema = z
  .object({
    id: z.string().regex(ID_RE, "invalid extension id"),
    name: z.string().min(1),
    version: z.string().regex(SEMVER_RE, "invalid version (expect x.y.z)"),
    coreApi: z.string().regex(RANGE_RE, "invalid coreApi range"),
    description: z.string().optional(),
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
  })
  // 其餘欄位(migrations/settings/adminPages/publicRoutes/hooks/uninstall)含 React
  // 型別與 function,不在 zod 深驗範圍,passthrough 保留。
  .passthrough();

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
  | "payment:succeeded" // (payload: { providerId; event: unknown })
  | "extraction:completed" // (payload: { providerId; event: unknown })
  // filters(第一個參數是值,回傳修改後的值)
  | "filter:adminMenu" // (items: AdminMenuItem[]) => AdminMenuItem[]
  | "filter:publicHome"; // (component: ComponentType | null) => ComponentType | null
// v1 刻意不含 head/meta 注入 filter(App Router 的 <head> 管理方式不同,留待未來)

export interface AdminMenuItem {
  href: string;
  title: string;
  order?: number;
}
