import type { DashboardRevenueContext, Extension } from "@/ext/types";
import type { Locale } from "@/lib/i18n";
import { resolveDashboardRevenue, seriesTotal, type ResolvedRevenueSeries } from "@/ext/dx/dashboard-revenue";
import { parseReportPeriod, previousPeriod, type PeriodParamsInput, type ReportPeriod } from "@/lib/report-period";

// 1.61.0:儀表板營業額卡的資料。期間照網址(lib/report-period.ts),這一段與緊接在前、一樣長的
// 那一段同時問每個有 dashboardRevenue 的插件(兩次呼叫:插件的 href 帶的是這一段的期間,
// 不能拿一次加倍的期間再切)。驗證、隔離與 canOpen 在 ext/dx/dashboard-revenue.ts。

export interface DashboardRevenueData {
  period: ReportPeriod;
  series: ResolvedRevenueSeries[];
  total: number;
  /**
   * 前一段的合計(只算這一段有畫的線)。有任何一條線拿不到前一段(那次呼叫失敗、逾時)時是
   * null —— 少一條線的比較會失真,寧可不比。
   */
  previousTotal: number | null;
}

export interface DashboardRevenueOptions {
  params: PeriodParamsInput;
  now: number;
  timeZone: string;
  locale: Locale;
  /** 看的人打不打得開這個後台連結;省略 = 全部(預設角色)。 */
  canOpen?: (href: string) => boolean;
  timeoutMs?: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** 沒有插件提供營業額,或看的人一條線都打不開 → null(卡片不畫)。永遠不 throw。 */
export async function loadDashboardRevenue(
  exts: readonly Extension[],
  { params, now, timeZone, locale, canOpen, timeoutMs }: DashboardRevenueOptions,
): Promise<DashboardRevenueData | null> {
  const providers = exts.filter((ext) => typeof ext.dashboardRevenue === "function");
  if (providers.length === 0) return null;
  const period = parseReportPeriod(params, now, timeZone);
  const previous = previousPeriod(period);
  const ctxFor = (p: ReportPeriod): DashboardRevenueContext => ({
    now,
    timeZone: p.timeZone,
    locale,
    canOpen: canOpen ?? (() => true),
    from: p.from,
    to: p.to,
    start: p.start,
    end: p.end,
  });
  const [current, before] = await Promise.all([
    resolveDashboardRevenue(providers, ctxFor(period), timeoutMs),
    resolveDashboardRevenue(providers, ctxFor(previous), timeoutMs),
  ]);
  if (current.length === 0) return null;
  const beforeTotals = new Map(before.map((series) => [series.key, seriesTotal(series)]));
  const comparable = current.every((series) => beforeTotals.has(series.key));
  return {
    period,
    series: current,
    total: sum(current.map(seriesTotal)),
    previousTotal: comparable ? sum(current.map((series) => beforeTotals.get(series.key) ?? 0)) : null,
  };
}
