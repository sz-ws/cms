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
import type { Locale } from "@/lib/i18n";
import { isSqlIdentifier, type AdminPageSearch } from "./record-search";
import {
  STATUS_KEY_RE,
  STATUS_SET_ID_RE,
  STATUS_TONES,
  type StatusSetDecl,
} from "./record-status";
import { validateSettingValue } from "../lib/setting-validation";
import { normalizeHex } from "../lib/color";
import { rangeStartsAtOrAfter } from "./semver";
import { IDENTITY_MAX, IDENTITY_RE } from "./plugin-ref";
import {
  ADMIN_APPEARANCES_MAX,
  ADMIN_APPEARANCE_ID_RE,
  adminAccentSchema,
  adminThemeSchema,
  type ExtensionAppearance,
} from "../lib/admin-theme";
import {
  adminIconIssue,
  extensionMenuSchema,
  type ExtensionMenu,
} from "./admin-menu";
import { dashboardWidgetsSchema, metricsSchema, type DashboardWidgetDecl, type MetricDecl } from "./dashboard-widgets";
import type { DashboardStat, DashboardStatsContext } from "./dx/dashboard-stats";
import type { DashboardRevenueContext, RevenueSeries } from "./dx/dashboard-revenue";
import {
  MAX_MEMBER_FACETS,
  MAX_MEMBER_FACET_ACTIONS,
  MEMBER_FACET_ID_RE,
} from "./member-facets";

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
  /** 1.44.0:另一個設定是某個值時才顯示;key 寫同一個 extension 的設定 key。 */
  showWhen?: { key: string; equals: string | boolean };
}
export type SettingField = SettingFieldBase &
  (
    | { type: "text" | "textarea" }
    // 1.52.0:unit 讓設定頁在欄位旁換算(1440 分鐘 → 「= 24 小時」),存的值不變。
    | { type: "number"; unit?: "minutes" }
    | { type: "boolean" }
    // §1 #11:settings select 已 value/label 分離,label 可乾淨 localize。
    // 1.44.0:presentation: "tabs" 畫成分頁;選項可帶 logo(站內圖片路徑)與選到時的說明。
    | {
        type: "select";
        options: { value: string; label: LocalizedString; logo?: string; description?: LocalizedString }[];
        presentation?: "tabs";
      }
    // 1.40.0:顏色(#rrggbb),設定頁畫成一排色票 + 自訂;swatches 省略時只有自訂。
    | { type: "color"; swatches?: { value: string; label: LocalizedString }[] }
  );

export interface AdminPage {
  slug: string; // "" = extension 主頁;URL: /admin/ext/<extId>/<slug>
  // §1 #12:sidebar 標題可 localize;interpret 透傳原始 LocalizedString(memo-safe),
  // 於 admin layout 每 request 以 getLocale() resolve。
  title: LocalizedString; // 顯示在 sidebar
  showInMenu?: boolean; // default true
  /**
   * 1.40.0:這一頁的搜尋宣告 —— core 在頂欄畫搜尋框、條件放網址,頁面用
   * parseRecordSearch / useRecordSearch 取用;加 `global` 同時進 ⌘K(record-search.ts)。
   */
  search?: AdminPageSearch;
  /**
   * 1.46.0:這一頁取代別的 extension 的哪幾頁:"<extId>" 是對方的主頁,
   * "<extId>/<slug>" 是對方的子頁。本 extension 啟用時,被取代的頁從側欄拿掉,
   * 直接開那個網址會轉到這一頁(ext/admin-menu.ts 的 replacedAdminPages)。
   * 例:商城營運的訂單管理取代商店的訂單頁(replaces: ["shop"])。
   */
  replaces?: string[];
  /**
   * 1.50.0:這一頁跟著哪一頁的權限(角色與權限):"<extId>" 是那個 extension 的主頁,
   * "<extId>/<slug>" 是子頁。給不在側欄的明細頁、編輯頁用 —— 能看列表的人就能開明細。
   * 沒宣告 = 看這一頁自己的授權(不在側欄的頁,自訂角色就打不開)。
   * 例:declarative 的編輯頁自動跟著它的列表頁。
   */
  accessAs?: string;
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
  /**
   * 1.50.0:這條 API 跟著哪一頁的權限(格式同 AdminPage.accessAs)。自訂角色讀(GET)
   * 要那一頁的「檢視」,寫要「編輯」。沒宣告 = 看這個 extension 所有頁裡最高的一級。
   * 預設角色(admin / editor / guest)不看這個欄位。
   */
  accessAs?: string;
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

// 1.62.0:儀表板的卡片(dashboardWidgets、metrics)的形狀在 ./dashboard-widgets.ts;1.52.0 的
// dashboardStats 與 1.61.0 的 dashboardRevenue 的型別跟著它們的轉接放在 dx/(2.0 拿掉)。
export type {
  DashboardWidgetDecl,
  MetricCombine,
  MetricDecl,
  Unit,
  WidgetContext,
  WidgetData,
  WidgetKind,
  WidgetListData,
  WidgetNumberData,
  WidgetPeriod,
  WidgetProportionData,
  WidgetTimeseriesData,
} from "./dashboard-widgets";
export type { DashboardStat, DashboardStatsContext } from "./dx/dashboard-stats";
export type { DashboardRevenueContext, RevenueSeries } from "./dx/dashboard-revenue";

/**
 * 1.60.0:插件在成員頁(/admin/users)上說明「這個人對我是什麼」(Extension.memberFacets)。
 * 例:經銷插件的 facet「經銷商」,badge "D001",側欄寫「可用點數 120」,連到經銷頁。
 *
 * 每個 facet 在成員表多一欄(badge,可在「顯示」選單關掉)、篩選列多一組「有／沒有」
 * (網址參數 `<extId>.<id>=has|missing`,匯出 CSV 照同一組條件)、匯出多一欄(badge)、
 * 成員側欄多一段(lines 與 actions)。只有打得開成員頁的人看得到(今天是管理員)。
 * 讀取與驗證規則見 ./member-facets.ts。
 */
export interface MemberFacet {
  /** 同一個插件內唯一:^[a-z][a-z0-9-]{0,30}$。全站的 key 是 `<extId>.<id>`。 */
  id: string;
  /** 欄位、篩選與側欄段落的名稱,例:{ "zh-Hant": "經銷商", en: "Dealer" }。 */
  label: LocalizedString;
  /**
   * 一次讀成員頁上的所有人(可能上千個 id)。只回這個 facet 適用的人:userId → 值;
   * 不適用的人不要放。每次打開成員頁或匯出 CSV 呼叫一次,所有插件同時讀。
   * 丟例外、回傳不是物件、或 3 秒內沒回來,這個 facet 整個不出現(伺服器記一行),頁面照常。
   * userIds 可能很長:D1 一個查詢最多綁 100 個參數,讀自己的表再用 userIds 挑,或自己分批。
   */
  read(userIds: string[], ctx: MemberFacetContext): Promise<Record<string, MemberFacetValue>>;
  /** 成員側欄的連結(最多 4 個)。 */
  actions?: MemberFacetAction[];
}

/** 1.60.0:MemberFacet.read 回來的一個人的值。 */
export interface MemberFacetValue {
  /** 表格與匯出用的短字(1–32 字),例:"D001"。 */
  badge: string;
  /** 側欄的欄位與值(最多 8 行;label ≤ 40 字、value ≤ 200 字),例:{ label: "可用點數", value: "120" }。
   * 沒給 lines 時側欄寫 badge。 */
  lines?: { label: string; value: string }[];
}

/** 1.60.0:成員側欄的一個連結。 */
export interface MemberFacetAction {
  label: LocalizedString;
  /** has = 有值的人才出現、missing = 沒值的人才出現、always = 都出現。 */
  when: "has" | "missing" | "always";
  /** 後台頁(/admin 開頭、小寫路徑段,可帶 query)。value 是 read 回來的這個人的值(原樣;沒有值是
   * undefined)。丟例外或不是後台頁,這個連結不出現。 */
  href(userId: string, value?: MemberFacetValue): string;
}

/** 1.60.0:MemberFacet.read 收到的內容。 */
export interface MemberFacetContext {
  /** 這個插件的 services(scope 綁在自己的 extId;資料庫是 services.db,設定是 services.settings)。 */
  services: CoreServices;
  /** 後台語言(lines 的字照它寫)。 */
  locale: Locale;
  /** 站台時區(settings 的 core.timeZone),寫日期用。 */
  timeZone: string;
}

export interface Extension {
  id: string; // ^[a-z][a-z0-9-]{1,30}$
  /** 1.50.0:跨來源的全域名字 `<publisher>/<name>`(見 ./plugin-ref.ts)。商店用它分辨
   * 「同 id 的另一個插件」;別的插件的相依宣告也可以用它指名。 */
  identity?: string;
  // §1 #1/#2:declarative interpret 透傳原始 LocalizedString(memo-safe);server 端
  // 消費點(dashboard extName、settings 分頁標題、extensions 列表 DTO)以 getLocale()
  // resolve。code extension 給純字串即可(string ⊂ LocalizedString)。
  name: LocalizedString;
  version: string; // semver
  coreApi: string; // core-v2 §1:相容的 CORE_API_VERSION semver range,如 "^1.0.0"
  description?: LocalizedString;
  /**
   * admin 側欄圖示:圖示代號(如 "truck",見 adminNavIcons.tsx),或 1.39.0 起可直接
   * 給一段 `<svg>`(過 svg-guard;用 currentColor 才會跟著側欄的選取色變)。
   */
  icon?: string;
  /** 1.39.0:側欄分區與巢狀(見 ./admin-menu.ts)。 */
  menu?: ExtensionMenu;
  /** OG image 設定(declarative extensions only)。 */
  og?: {
    image?: {
      template: string;
      brand?: string;
    };
  };
  /** 1.36.0: enabled code extensions required for this extension. */
  requiresExtensions?: string[];
  /** Trusted SQL predicate, evaluated atomically with disabling. No user SQL. */
  canDisable?: { sql: string; message: string };
  /** Persistent financial plugins may permit disabling but forbid destructive uninstall. */
  canUninstall?: boolean;
  migrations?: ExtMigration[];
  settings?: SettingField[];
  adminPages?: AdminPage[];
  apiRoutes?: ApiRoute[];
  publicRoutes?: PublicRoute[];
  /**
   * 1.55.0:這個插件提供網站唯一的登入頁(站內路徑,例:"/member/sign-in")。有啟用的插件
   * 宣告時,/login 轉到這一頁;所有人(後台人員、會員)從同一個入口登入,登入後由
   * /api/auth/continue 依身分分流(lib/sign-in-page.ts)。/login?form=1 仍是後台的表單,
   * 給插件頁壞掉時救急。
   */
  signInPage?: string;
  /**
   * 1.57.0:後台預設風格(≤6)。出現在設定 → 風格 →「從一款風格開始」,排在內建預設之後、
   * 標上插件名稱;選了只是填進編輯器,管理員照常儲存。theme 用後台風格的 adminThemeSchema
   * 驗證(font/icons 可省略),accent 只收 #rrggbb,省略時保留目前的主色。沒有自訂 CSS。
   * 插件停用時選項消失,已存的風格不變。
   */
  appearances?: ExtensionAppearance[];
  // Alpha:讓 dispatch 識別 public type(POST 跳 requireAuth);不必走 Extension 介面,
  // 直接由 interpret.tsx 從 manifest.contentTypes 衍生。
  contentTypes?: DeclarativeContentType[];
  // roadmap #16:extension 貢獻的 dashboard 卡(stat/recent)。declarative 由 interpret
  // 從 manifest.dashboardCards 直接帶入;code extension 之後也可自行設定同欄位。
  dashboardCards?: DeclarativeDashboardCard[];
  /**
   * 1.62.0:插件放在儀表板上的卡片(DashboardWidgetDecl,最多 12 張):number / timeseries /
   * proportion / list。core 呼叫 load()、驗資料、管期間與比前一段、合併同一個 metric 的卡、照 unit
   * 寫數字(./dashboard-widgets.ts、dx/dashboard-widgets.ts)。需要 coreApi "^1.62.0"。
   */
  dashboardWidgets?: DashboardWidgetDecl[];
  /**
   * 1.62.0:這個插件用到的共用數字(MetricDecl,最多 8 個)。這個插件的 widget 只能用這裡宣告的 metric;
   * 用同一個 metric 的 widget(可以來自不同插件)合成一張卡。幾個插件宣告同一個 key 時要一模一樣,
   * 不一樣的以先載入的插件為準,後面那個插件在它上面的 widget 不畫。需要 coreApi "^1.62.0"。
   */
  metrics?: MetricDecl[];
  /**
   * 1.52.0:插件自己的儀表板數字(DashboardStat)。每次打開儀表板呼叫一次;丟例外、
   * 回傳不是陣列、或 2 秒內沒回來,這個插件的數字就不顯示,其他照常。
   * @deprecated 1.62.0:改用 dashboardWidgets 的 `kind: "number"`(dx/dashboard-stats.ts 轉接)。2.0 拿掉。
   */
  dashboardStats?: (ctx: DashboardStatsContext) => Promise<DashboardStat[]>;
  /**
   * 1.61.0:儀表板的每日金額(RevenueSeries)。需要 coreApi "^1.61.0"。
   * @deprecated 1.62.0:改成宣告 commerce-kit 的 REVENUE(metrics)加一個 metric 是它的 timeseries
   * widget(dx/dashboard-revenue.ts 轉接)。2.0 拿掉。
   */
  dashboardRevenue?: (ctx: DashboardRevenueContext) => Promise<RevenueSeries[]>;
  /**
   * 1.60.0:成員頁上這個插件的欄位、篩選、匯出欄與側欄段落(MemberFacet,最多 4 個)。
   * 需要 coreApi "^1.60.0"。
   */
  memberFacets?: MemberFacet[];
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
  // ── 1.60.0:agentGuide ──────────────────────────────────────────────────────
  /**
   * 1.60.0:給 AI 的說明(src/ext/agent-guide.ts)。這個插件在後台管什麼、常見的事怎麼
   * 一步步做(用哪幾個 tool、照什麼順序)。插件啟用時接在 core 內建的說明後面,送進後台
   * 助理的 system prompt 與 AI 連線(MCP initialize 的 instructions)。
   *
   * 寫給模型看的:可以提 tool 名(點分寫法,MCP 那邊會自動換成破折號的名字)。每種語言
   * 最多 AGENT_GUIDE_MAX_CHARS 字。宣告了要標 coreApi "^1.60.0"(舊 core 會安靜地忽略)。
   */
  agentGuide?: LocalizedString;
  // ── end agentGuide ─────────────────────────────────────────────────────────
  /**
   * 1.40.0:紀錄的狀態組(名稱與色調),全站識別 `<extId>:<id>`。後台用 <StatusBadge>
   * 畫;站台用 filter:statusSets 改名或補描述;每一筆可另掛描述(record-status.ts)。
   */
  statusSets?: StatusSetDecl[];
  /**
   * 1.48.0:給宣告式插件 script 用的公開資料,名稱 → 載入函式。宣告式 manifest 以
   * `{{feed.<extId>.<name>}}` 取用,值會以 JSON 字面值嵌進**每個公開頁的原始碼** ——
   * 只能回本來就可以公開的東西(商品名、時間),不能有姓名、email、電話、地址。
   * 丟例外或逾時視為 null,不影響頁面。
   */
  publicFeeds?: Record<string, () => Promise<unknown>>;
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

// 後台頁參照 "<extId>" / "<extId>/<slug>"(AdminPage.replaces、accessAs 共用的格式)。
const PAGE_REF_RE = /^[a-z][a-z0-9-]{1,30}(\/[a-z0-9][a-z0-9-]*)*$/;

const apiRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // path:segment 字串,允許 :param;禁止 regex 特殊語意(僅 [a-z0-9:/-])。
  path: z
    .string()
    .min(1)
    .regex(/^[a-z0-9:/-]+$/i, "invalid route path"),
  public: z.boolean().optional(), // 1.28.0:免登入端點(見 ApiRoute.public)
  accessAs: z.string().regex(PAGE_REF_RE, "accessAs must be <extId> or <extId>/<slug>").optional(), // 1.50.0
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

// 1.40.0:後台頁的搜尋宣告(record-search.ts 的 AdminPageSearch)。欄位名會拼進
// SQL,只收小寫識別字;⌘K 來源只開放 ext_ 開頭的表 —— core 的表(users、sessions…)
// 不給翻。
const sqlIdent = z.string().refine(isSqlIdentifier, "invalid SQL identifier");
const adminPageSearchSchema = z
  .object({
    placeholder: localizedStringSchema,
    fields: z
      .object({
        text: z.array(sqlIdent).max(10),
        phone: z.array(sqlIdent).max(5).optional(),
        date: sqlIdent.optional(),
      })
      .strict()
      .refine((fields) => fields.text.length + (fields.phone?.length ?? 0) > 0, "search needs a text or phone field"),
    global: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "invalid search source id"),
        label: localizedStringSchema,
        table: sqlIdent.refine((table) => table.startsWith("ext_"), "global search table must start with ext_"),
        key: sqlIdent,
        title: sqlIdent,
        subtitle: z.array(sqlIdent).max(3).optional(),
        replaces: z.string().regex(/^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9-]{0,39}$/, "replaces must be <extId>:<sourceId>").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// 1.40.0:狀態組(record-status.ts)。狀態值是插件寫進資料的字串,只收識別字。
const statusSetSchema = z
  .object({
    id: z.string().regex(STATUS_SET_ID_RE, "invalid status set id"),
    statuses: z
      .record(
        z.string().regex(STATUS_KEY_RE, "invalid status key"),
        z.object({ label: localizedStringSchema, tone: z.enum(STATUS_TONES).optional() }).strict(),
      )
      .refine((statuses) => Object.keys(statuses).length > 0, "status set needs at least one status"),
  })
  .strict();

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

// ── 1.60.0:agentGuide ──────────────────────────────────────────────────────
/** Extension.agentGuide 每種語言的字數上限。給 AI 的說明是有總量的,一個插件不該吃掉一大塊。 */
export const AGENT_GUIDE_MAX_CHARS = 1_200;
const agentGuideSchema = nonEmptyLocalizedString.refine(
  (value) =>
    (typeof value === "string" ? [value] : Object.values(value)).every(
      (text) => typeof text !== "string" || text.length <= AGENT_GUIDE_MAX_CHARS,
    ),
  { message: `agentGuide is limited to ${AGENT_GUIDE_MAX_CHARS} characters per language` },
);
// ── end agentGuide ─────────────────────────────────────────────────────────

const settingSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "invalid setting key"),
    label: localizedStringSchema,
    description: localizedStringSchema.optional(),
    default: z.unknown(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    type: z.enum(["text", "textarea", "number", "boolean", "select", "color"]),
    unit: z.enum(["minutes"]).optional(),
    options: z
      .array(
        z.object({ value: z.string(), label: localizedStringSchema }).strict(),
      )
      .optional(),
    swatches: z
      .array(
        z
          .object({
            value: z.string().refine((value) => normalizeHex(value) === value, "swatch must be #rrggbb (lower-case)"),
            label: localizedStringSchema,
          })
          .strict(),
      )
      .max(16)
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
    if (setting.unit !== undefined && setting.type !== "number") {
      ctx.addIssue({
        code: "custom",
        message: "unit is only valid for number settings",
        path: ["unit"],
      });
    }
    if (setting.swatches !== undefined && setting.type !== "color") {
      ctx.addIssue({
        code: "custom",
        message: "swatches are only valid for color settings",
        path: ["swatches"],
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
  accessAs: z.string().regex(PAGE_REF_RE, "accessAs must be <extId> or <extId>/<slug>").optional(), // 1.50.0
  search: adminPageSearchSchema.optional(),
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
    identity: z.string().max(IDENTITY_MAX).regex(IDENTITY_RE, "invalid identity (expect <publisher>/<name>)").optional(),
    // spec-extension-i18n.md §1 #1/#2:頂層 name/description 與 label/title 一樣是
    // LocalizedString。Extension 介面自 1.17.0 起就這樣宣告了,但這裡的 zod 還停在
    // 純 z.string() —— 於是寫物件形式的 code extension 過得了 tsc、卻要等到
    // `next build` 的 collecting page data 才在一個看似無關的路由上炸開。驗證跟上
    // 型別,失敗點才會回到 defineExtension 本身。
    name: nonEmptyLocalizedString,
    version: z.string().regex(SEMVER_RE, "invalid version (expect x.y.z)"),
    coreApi: z.string().regex(RANGE_RE, "invalid coreApi range"),
    description: localizedStringSchema.optional(),
    icon: z.string().max(16384).optional(),
    menu: extensionMenuSchema.optional(),
    canUninstall: z.boolean().optional(),
    requiresExtensions: z.array(z.string().regex(ID_RE)).max(20).optional(),
    canDisable: z.object({ sql: z.string().min(1).refine((sql) => !/;|--|\/\*|\*\//.test(sql), "invalid disable predicate"), message: z.string().min(1).max(300) }).strict().optional(),
    migrations: z.array(migrationSchema).optional(),
    uninstall: z.array(migrationSchema).optional(),
    settings: z.array(settingSchema).optional(),
    adminPages: z.array(adminPageSchema).optional(),
    publicRoutes: z.array(publicRouteSchema).optional(),
    // 站內絕對路徑,不能是後台、/login、/api(否則 /login 會轉回自己或轉進後台)。
    signInPage: z
      .string()
      .max(200)
      .regex(/^\/[a-z0-9][a-z0-9/_-]*$/i, "signInPage must be a site path like /member/sign-in")
      .refine((p) => !/^\/(admin|login|setup|api)(\/|$)/i.test(p), "signInPage cannot be an admin, login, setup or api path")
      .optional(),
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
    agentGuide: agentGuideSchema.optional(), // 1.60.0
    statusSets: z.array(statusSetSchema).max(10).optional(),
    publicFeeds: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/, "invalid feed name"), fn)
      .optional(),
    dashboardStats: fn.optional(), // deprecated 1.62.0
    dashboardRevenue: fn.optional(), // 1.61.0; deprecated 1.62.0
    dashboardWidgets: dashboardWidgetsSchema.optional(), // 1.62.0
    metrics: metricsSchema.optional(), // 1.62.0
    // 1.60.0:成員頁的 facet(MemberFacet;讀取與驗證在 ./member-facets.ts)。
    memberFacets: z
      .array(
        z
          .object({
            id: z.string().regex(MEMBER_FACET_ID_RE, "invalid member facet id"),
            label: nonEmptyLocalizedString,
            read: fn,
            actions: z
              .array(
                z
                  .object({
                    label: nonEmptyLocalizedString,
                    when: z.enum(["has", "missing", "always"]),
                    href: fn,
                  })
                  .strict(),
              )
              .max(MAX_MEMBER_FACET_ACTIONS)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MEMBER_FACETS)
      .optional(),
    appearances: z
      .array(
        z
          .object({
            id: z.string().regex(ADMIN_APPEARANCE_ID_RE, "invalid appearance id"),
            name: nonEmptyLocalizedString,
            description: localizedStringSchema.optional(),
            theme: adminThemeSchema,
            accent: adminAccentSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ADMIN_APPEARANCES_MAX)
      .optional(),
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

    if (ext.canUninstall !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.37.0")) ctx.addIssue({ code: "custom", message: "uninstall protection requires coreApi >= 1.37.0", path: ["coreApi"] });
    const iconIssue = ext.icon === undefined ? null : adminIconIssue(ext.icon);
    if (iconIssue) ctx.addIssue({ code: "custom", message: iconIssue, path: ["icon"] });
    if (ext.menu?.parent === ext.id) ctx.addIssue({ code: "custom", message: "extension menu cannot nest under itself", path: ["menu", "parent"] });
    duplicate(ext.requiresExtensions ?? [], "requiresExtensions", "required extension");
    if (ext.requiresExtensions?.includes(ext.id)) ctx.addIssue({ code: "custom", message: "extension cannot depend on itself", path: ["requiresExtensions"] });
    if ((ext.requiresExtensions?.length || ext.canDisable) && !rangeStartsAtOrAfter(ext.coreApi, "1.36.0")) ctx.addIssue({ code: "custom", message: "lifecycle guards require coreApi >= 1.36.0", path: ["coreApi"] });
    if (ext.identity !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.50.0")) ctx.addIssue({ code: "custom", message: "identity requires coreApi >= 1.50.0", path: ["coreApi"] });
    duplicate((ext.settings ?? []).map((item) => item.key), "settings", "setting key");
    duplicate((ext.migrations ?? []).map((item) => item.id), "migrations", "migration id");
    duplicate((ext.uninstall ?? []).map((item) => item.id), "uninstall", "uninstall migration id");
    duplicate((ext.adminPages ?? []).map((item) => item.slug), "adminPages", "admin page slug");
    duplicate((ext.statusSets ?? []).map((set) => set.id), "statusSets", "status set id");
    if (ext.statusSets?.length && !rangeStartsAtOrAfter(ext.coreApi, "1.40.0")) ctx.addIssue({ code: "custom", message: "statusSets require coreApi >= 1.40.0", path: ["coreApi"] });
    const searchPages = (ext.adminPages ?? []).filter((page) => page.search);
    duplicate(searchPages.flatMap((page) => (page.search?.global ? [page.search.global.id] : [])), "adminPages", "global search id");
    if (searchPages.length && !rangeStartsAtOrAfter(ext.coreApi, "1.40.0")) ctx.addIssue({ code: "custom", message: "admin page search requires coreApi >= 1.40.0", path: ["coreApi"] });
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
    duplicate((ext.appearances ?? []).map((item) => item.id), "appearances", "appearance id");
    // passthrough 的舊 core 會安靜忽略這個欄位(選項不出現、沒有錯誤),同 agentTools 的理由標版號。
    if (ext.appearances !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.57.0")) ctx.addIssue({ code: "custom", message: 'appearances requires coreApi "^1.57.0" or newer', path: ["coreApi"] });
    duplicate((ext.memberFacets ?? []).map((facet) => facet.id), "memberFacets", "member facet id");
    // 舊 core 會安靜忽略這個欄位(成員頁少了欄位,沒有錯誤),同 appearances 的理由標版號。
    if (ext.memberFacets !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.60.0")) ctx.addIssue({ code: "custom", message: 'memberFacets requires coreApi "^1.60.0" or newer', path: ["coreApi"] });
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
    // 1.60.0:agentGuide —— 同 agentTools 的理由,舊 core 會安靜地忽略,所以標版號。
    if (ext.agentGuide !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.60.0")) {
      ctx.addIssue({ code: "custom", message: 'agentGuide requires coreApi "^1.60.0" or newer', path: ["coreApi"] });
    }
    // 1.62.0:儀表板的卡片 —— 舊 core 會安靜地忽略(卡片不出現,沒有錯誤),所以標版號。
    for (const field of ["dashboardWidgets", "metrics"] as const) {
      if (ext[field] !== undefined && !rangeStartsAtOrAfter(ext.coreApi, "1.62.0")) {
        ctx.addIssue({ code: "custom", message: `${field} requires coreApi "^1.62.0" or newer`, path: ["coreApi"] });
      }
    }
    // 1.62.0:widget 用的 metric 要在同一個插件的 metrics 裡(每個插件自己帶齊,不靠別的插件宣告)。
    const declaredMetrics = new Set((ext.metrics ?? []).map((metric) => metric.key));
    (ext.dashboardWidgets ?? []).forEach((widget, index) => {
      if (widget.metric !== undefined && !declaredMetrics.has(widget.metric)) {
        ctx.addIssue({ code: "custom", message: `widget "${widget.id}" uses metric "${widget.metric}", which this plugin does not declare in metrics`, path: ["dashboardWidgets", index, "metric"] });
      }
    });
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
  // 1.56.0:每一次成功登入之後(session 與 cookie 都已建好)。payload 是 SignedInEvent
  // (src/lib/signed-in.ts):{ userId; method; provider?; emailVerified }。
  //   method:"password" | "passkey" | "oauth"(provider = 登入插件 id)| "firebase"(同左)
  //          | "reset"(忘記密碼設好新密碼)| "code"(插件自己的 Email 驗證碼,provider = 插件 id)。
  //   emailVerified:**這一次**登入證明了帳號的 Email 是本人的 —— 驗證碼(reset / code),
  //          或第三方說 email_verified === true 且就是帳號的 Email。密碼與 Passkey 恆為 false。
  // handler 出錯只記錄,不擋登入。插件自己的登入流程用 fireSignedIn() 觸發同一個 hook。
  | "auth:signed-in" // (event: SignedInEvent)
  // filters(第一個參數是值,回傳修改後的值)
  | "filter:adminMenu" // (items: AdminMenuItem[]) => AdminMenuItem[]
  // 1.40.0:側欄分區(id / label / order / collapse)。預設五區:workspace、content、
  // commerce、shop、system;站台改名、加區、排序,項目再用 filter:adminMenu 的
  // `section` 指過去。輸出經 normalizeAdminSections 收斂(ext/admin-menu.ts)。
  | "filter:adminSections" // (sections: AdminNavSection[]) => AdminNavSection[]
  // 1.40.0:狀態組的 slot —— 站台改名(label)或補描述(addon),只影響後台顯示。
  // 值是 ResolvedStatusSets(`<extId>:<setId>` → 狀態 → { label, tone, addon });
  // 輸出經 normalizeStatusSets 收斂(ext/record-status.ts),不能憑空加狀態。
  | "filter:statusSets" // (sets: ResolvedStatusSets) => ResolvedStatusSets
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
