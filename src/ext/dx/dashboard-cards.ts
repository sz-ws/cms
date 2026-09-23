import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents } from "@/lib/schema";
import { displayValue, pickTitleField } from "./views/field-utils";
import type { DeclarativeDashboardCard } from "./manifest";
import type { DashboardStatsContext, Extension } from "../types";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";
import { normalizeTimeZone } from "@/lib/datetime";
import { collectDashboardStats } from "./dashboard-stats";

// roadmap #16:把 enabled extensions 宣告的 dashboardCards 解析成可渲染的資料。
//   stat   → 對共用 contents 表做 count(*)(可選 status filter)。
//   recent → 取最近更新(updatedAt desc)的 limit 筆,並抽出每筆的顯示標題。
//
// 韌性(spec §5 的精神:dashboard 絕不因某個 extension 的壞資料而整頁掛掉):
//   每張卡各自 try/catch —— 單卡的 contentType 未宣告、或 DB 查詢失敗 → console.error
//   並「略過該卡」回 null,絕不 throw。resolveDashboardCards 過濾掉 null。
//
// adminHref 決策:連到列出這個 content type 的後台頁。1.52.0 起呼叫端可以給 hrefs
// (typeKey → 列表頁,儀表板從 type-directory 拿到的 collectionHrefs),declarative 的類型
// 列在子頁(例如商品目錄的分類在 /admin/ext/catalog/categories)時卡片才會連對、編輯連結
// 才會是那一頁的 `<列表頁>/edit?id=`。沒給(或不在表裡,例如 code extension 自己宣告的
// 類型)就退回 extension 的 admin 根頁 `/admin/ext/<extId>`。此處不重讀 manifest/DB,讓資料
// 層與 declarative_extensions 表解耦(單元測試僅需 contents 表即可覆蓋)。
//
// 1.52.0:canOpen(自訂角色,dashboard/viewer.ts)—— 卡片的來源頁(adminHref)打不開就
// 整張略過,連查詢都不發。預設角色不給,照舊全部。
//
// 1.52.0:code extension 的 dashboardStats(插件自己的數字,dashboard-stats.ts)也在這裡收:
// 每個插件一份 ctx(now、站台時區、語言、canOpen;預設角色的 canOpen 全部放行),驗過的數字
// 變成 kind "stat" 的卡(count = value,另有 display / hint / statId,沒有 contentType),
// 排在同一個插件的 dashboardCards 之後。

const DEFAULT_RECENT_LIMIT = 5;

/** recent 卡的單列(對映一筆 content entry)。 */
export interface ResolvedRecentEntry {
  id: string;
  title: string;
  status: "draft" | "published";
  updatedAt: number;
  editHref: string;
}

/** 一張解析完成、可直接渲染的 dashboard 卡。 */
export interface ResolvedDashboardCard {
  extId: string;
  extName: string;
  kind: "stat" | "recent";
  title: string;
  /** 完整 content type key "<extId>.<name>"(查 contents 表用);插件自己的數字沒有。 */
  contentType?: string;
  /** 1.52.0:插件自己的數字(dashboardStats)的 id;內容類型的卡沒有。 */
  statId?: string;
  /** 列出這個類型的後台頁(見檔頭決策);插件的數字是它給的 href。 */
  adminHref: string;
  /** stat 專用:卡片上的數字 —— 內容類型卡是符合條件的 entry 總數,插件的數字是它的 value。 */
  count?: number;
  /** 1.52.0 插件的數字:格式化好的顯示字串,有就取代 count 的語系格式。 */
  display?: string;
  /** 1.52.0 插件的數字:標題下的小字,取代插件名稱。 */
  hint?: string;
  /** recent 專用:最近更新的 entry 列。 */
  entries?: ResolvedRecentEntry[];
}

/** 解析的選項(1.52.0)。 */
export interface DashboardCardOptions {
  /** typeKey → 列出那個類型的後台頁;沒有的退回 `/admin/ext/<extId>`。 */
  hrefs?: Readonly<Record<string, string>>;
  /** 這個人打不打得開卡片的來源頁;省略 = 全部顯示(預設角色)。 */
  canOpen?: (href: string) => boolean;
  /** dashboardStats 的「現在」;省略 = Date.now()。 */
  now?: number;
  /** 站台時區(getSiteTimeZone);省略或壞值 = 台北(lib/datetime DEFAULT_TIME_ZONE)。 */
  timeZone?: string;
  /** 每個插件 dashboardStats 的時限;省略 = DASHBOARD_STATS_TIMEOUT_MS。 */
  statsTimeoutMs?: number;
}

/** 解析單張卡;任何失敗都吞成 null(呼叫端過濾),不 throw。 */
async function resolveCard(
  ext: Extension,
  card: DeclarativeDashboardCard,
  locale: Locale,
  opts: DashboardCardOptions,
): Promise<ResolvedDashboardCard | null> {
  const ct = (ext.contentTypes ?? []).find((c) => c.name === card.contentType);
  if (!ct) {
    // 卡引用了未宣告的 contentType(interpret 端 manifest schema 應已擋下,但 code
    // extension 可能繞過驗證直接設定 dashboardCards):略過此卡,不 throw。
    console.error(
      `[dashboard-cards] ext="${ext.id}" card references unknown content type "${card.contentType}"; skipped`,
    );
    return null;
  }

  const typeKey = `${ext.id}.${card.contentType}`;
  const adminHref = opts.hrefs?.[typeKey] ?? `/admin/ext/${ext.id}`;
  if (opts.canOpen && !opts.canOpen(adminHref)) return null;
  // §1 #13 → #3 → name:card.title 優先,退 ct.label,再退 ct.name(全走 resolve)。
  const title =
    resolveLocalizedString(card.title, locale) ??
    resolveLocalizedString(ct.label, locale) ??
    ct.name;
  const extName = resolveLocalizedString(ext.name, locale) ?? ext.id;

  try {
    if (card.kind === "stat") {
      const where = card.status
        ? and(eq(contents.type, typeKey), eq(contents.status, card.status))
        : eq(contents.type, typeKey);
      const rows = await db()
        .select({ n: count() })
        .from(contents)
        .where(where);
      return {
        extId: ext.id,
        extName,
        kind: "stat",
        title,
        contentType: typeKey,
        adminHref,
        count: rows[0]?.n ?? 0,
      };
    }

    // recent
    const limit = card.limit ?? DEFAULT_RECENT_LIMIT;
    const rows = await db()
      .select()
      .from(contents)
      .where(eq(contents.type, typeKey))
      .orderBy(desc(contents.updatedAt))
      .limit(limit);

    // 顯示標題:沿用既有的 pickTitleField + displayValue(同 aggregate.ts 的 recent
    // 取標題策略——slugField 欄位優先,否則第一個 text 欄位,否則第一個欄位);抽不到
    // 有意義的字串時退回 entry id。
    const titleField = pickTitleField(ct.fields, ct.slugField);
    const entries: ResolvedRecentEntry[] = rows.map((row) => {
      let data: Record<string, unknown> = {};
      try {
        const j = JSON.parse(row.data) as unknown;
        if (j && typeof j === "object") data = j as Record<string, unknown>;
      } catch {
        data = {};
      }
      const raw = titleField ? data[titleField.key] : undefined;
      const shown = titleField ? displayValue(titleField, raw).trim() : "";
      return {
        id: row.id,
        title: shown.length > 0 ? shown : row.id,
        status: row.status === "published" ? "published" : "draft",
        updatedAt: row.updatedAt,
        editHref: `${adminHref}/edit?id=${encodeURIComponent(row.id)}`,
      };
    });
    return {
      extId: ext.id,
      extName,
      kind: "recent",
      title,
      contentType: typeKey,
      adminHref,
      entries,
    };
  } catch (e) {
    console.error(
      `[dashboard-cards] ext="${ext.id}" card "${card.contentType}" query failed; skipped`,
      e,
    );
    return null;
  }
}

/**
 * 解析一組 extensions 貢獻的 dashboard 卡。每張卡獨立解析且獨立容錯(見 resolveCard);
 * 失敗的卡被略過,回傳只含成功解析者的陣列,保留宣告順序。
 */
export async function resolveDashboardCards(
  exts: Extension[],
  locale: Locale = "en",
  opts: DashboardCardOptions = {},
): Promise<ResolvedDashboardCard[]> {
  const statsCtx: DashboardStatsContext = {
    now: opts.now ?? Date.now(),
    timeZone: normalizeTimeZone(opts.timeZone),
    locale,
    canOpen: opts.canOpen ?? (() => true),
  };
  const jobs: Promise<ResolvedDashboardCard[]>[] = [];
  for (const ext of exts) {
    for (const card of ext.dashboardCards ?? []) {
      jobs.push(resolveCard(ext, card, locale, opts).then((c) => (c ? [c] : [])));
    }
    if (ext.dashboardStats) jobs.push(resolveStats(ext, locale, statsCtx, opts.statsTimeoutMs));
  }
  return (await Promise.all(jobs)).flat();
}

/** 一個插件的 dashboardStats → 數字卡(驗證與隔離在 dashboard-stats.ts)。 */
async function resolveStats(
  ext: Extension,
  locale: Locale,
  ctx: DashboardStatsContext,
  timeoutMs: number | undefined,
): Promise<ResolvedDashboardCard[]> {
  const stats = await collectDashboardStats(ext, ctx, timeoutMs);
  if (stats.length === 0) return [];
  const extName = resolveLocalizedString(ext.name, locale) ?? ext.id;
  return stats.map((stat) => ({
    extId: ext.id,
    extName,
    kind: "stat",
    title: stat.title,
    statId: stat.id,
    adminHref: stat.href,
    count: stat.value,
    ...(stat.display !== undefined ? { display: stat.display } : {}),
    ...(stat.hint !== undefined ? { hint: stat.hint } : {}),
  }));
}
