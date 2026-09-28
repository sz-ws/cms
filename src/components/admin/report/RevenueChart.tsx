"use client";

import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n";
import { REVENUE } from "@/ext/commerce-kit/metrics";
import { TimeseriesChart } from "../dashboard/widgets/TimeseriesChart";
import type { ChartSeries } from "../dashboard/widgets/timeseries";

// @deprecated 1.62.0 —— 1.61.0 的每日營業額圖,2.0 拿掉。改用 components/admin/dashboard/widgets 的
// TimeseriesChart,unit 給 { kind: "currency", code }(報表頁用 lib/units-server.ts 的 getSiteCurrency())。
// 這裡照 1.61.0 的樣子畫:新台幣、疊起來。

export interface RevenueChartProps {
  days: readonly string[];
  series: readonly ChartSeries[];
  locale: Locale;
  height?: number;
}

/** @deprecated 1.62.0:用 TimeseriesChart。 */
export function RevenueChart({ days, series, locale, height }: RevenueChartProps) {
  const label = resolveLocalizedString(REVENUE.label, locale) ?? REVENUE.key;
  return (
    <TimeseriesChart
      data={{ label, days: [...days], series: [...series], unit: { kind: "currency", code: "TWD" }, mode: "stacked" }}
      locale={locale}
      height={height}
    />
  );
}
