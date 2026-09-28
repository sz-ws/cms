import type { Extension } from "../types";
import type { LocalizedString } from "@/lib/i18n/localized";
import type { DashboardWidgetDecl, MetricDecl, WidgetTimeseriesData } from "../dashboard-widgets";
import { REVENUE } from "../commerce-kit/metrics";
import type { DashboardStatsContext } from "./dashboard-stats";
import type { WidgetSource } from "./dashboard-widgets";
import { describe } from "./dashboard-hook";

// @deprecated 1.62.0 —— 舊介面的轉接,2.0 整個檔案拿掉。
//
// 1.61.0 的 Extension.dashboardRevenue(插件交給儀表板的每日金額)。1.62.0 起插件改成宣告 commerce-kit 的
// REVENUE(`metrics: [REVENUE]`)加一個 `kind: "timeseries"`、`metric: REVENUE.key`、`period: true` 的
// dashboardWidgets。這裡把舊的 hook 包成同樣的一個 widget:宣告了 dashboardRevenue 的插件等於宣告了
// REVENUE 與這個 widget,之後的驗證、權限、合併、比前一段都走 dx/dashboard-widgets.ts 同一條路,畫出來
// 跟 1.61.0 一樣(同一張卡、同樣的規則:一天不對整條丟掉、金額 ≥ 0、每個插件最多 4 條、href 必填)。

/**
 * 1.61.0:插件交給儀表板的一條每日金額(Extension.dashboardRevenue)。
 * @deprecated 1.62.0:改用 dashboardWidgets 的 timeseries widget(metric 是 commerce-kit 的 REVENUE)。2.0 拿掉。
 */
export interface RevenueSeries {
  /** 同一個插件內唯一:^[a-z0-9][a-z0-9-]{0,40}$。 */
  id: string;
  /** 圖例上的名稱(最多 40 字)。 */
  label: LocalizedString;
  /** 看這筆錢明細的後台頁:`/admin` 開頭的站內路徑,可帶 query。看的人打不開就不顯示。 */
  href: string;
  /** 每天收到的金額:key 是站台時區的日期 YYYY-MM-DD(ctx.from..ctx.to),值 ≥ 0;沒列的日子當 0。 */
  days: Record<string, number>;
}

/**
 * 1.61.0:dashboardRevenue 收到的內容;期間照站台時區切成整天。
 * @deprecated 1.62.0:`period: true` 的 widget 收到 WidgetContext.period。2.0 拿掉。
 */
export interface DashboardRevenueContext extends DashboardStatsContext {
  /** 第一天(含),YYYY-MM-DD。 */
  from: string;
  /** 最後一天(含),YYYY-MM-DD。 */
  to: string;
  /** from 當天 00:00(ms)。 */
  start: number;
  /** to 隔天 00:00(ms),不含。 */
  end: number;
}

/** 宣告了 dashboardRevenue 的插件等於宣告了 REVENUE。 */
export function legacyRevenueMetrics(ext: Extension): MetricDecl[] {
  return typeof ext.dashboardRevenue === "function" ? [REVENUE] : [];
}

/** dashboardRevenue → 一個 REVENUE 上的 timeseries widget。 */
export function legacyRevenueWidgets(ext: Extension): WidgetSource[] {
  const hook = ext.dashboardRevenue;
  if (typeof hook !== "function") return [];
  const decl: DashboardWidgetDecl = {
    id: "dashboard-revenue",
    kind: "timeseries",
    metric: REVENUE.key,
    period: true,
    async load(ctx) {
      const period = ctx.period!;
      const raw: unknown = await hook({ now: ctx.now, timeZone: ctx.timeZone, locale: ctx.locale, canOpen: ctx.canOpen, ...period });
      if (!Array.isArray(raw)) throw new Error(`returned ${describe(raw)}, not an array`);
      // 舊介面的 href 是必填:沒給的那一條照新規則驗不過(null 不是後台頁),整條丟掉。
      const series = raw.map((entry) => {
        if (entry === null || typeof entry !== "object") return entry;
        const { id, label, href, days } = entry as Record<string, unknown>;
        return { id, label, href: href ?? null, points: days };
      });
      // 形狀不對的那一條留給 dashboard-widget-data.ts 驗(記一行、整條丟掉),跟新介面一樣。
      return { kind: "timeseries", bucket: "day", series } as unknown as WidgetTimeseriesData;
    },
  };
  return [{ decl, hook: "dashboardRevenue" }];
}
