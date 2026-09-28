"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AdminLink } from "@/components/admin/AdminLink";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n";
import { pointsTotal } from "@/lib/report-period";
import { compactNumber, formatUnit } from "@/lib/units";
import { axisTickDays, dailyRows, longDay, seriesColor, shortDay, slotOf, type ChartRow, type ChartSeries } from "./timeseries";
import type { TimeseriesChartData } from "./types";

// 1.62.0 每日趨勢家族 · TimeseriesChart(儀表板上插件的 timeseries 卡、插件的報表頁共用)。
// 1.61.0 的 RevenueChart 一般化:數字照 data.unit 寫(lib/units.ts),不再綁金額。
//   - stacked:一天一根,各條線疊在一起;提示框列每條線與當天合計(兩條以上),圖例寫期間合計。
//   - overlay:每條一條線,不加總;提示框列每條線,圖例只有名字。
//   - 顏色是後台主色的深淺(palette.ts);圖例在圖下面,給了 href 的名字連到那一頁。
//   - x 軸 10 天以內每天標,再多大約標 6 個(一定標到最後一天);整段都是 0 時 y 軸不標數字,
//     圖下說一句。
//   - 進場動畫是 recharts 的 "auto":伺服器上不畫、使用者要求減少動態時不動。

export interface TimeseriesChartProps {
  data: TimeseriesChartData;
  locale: Locale;
  /** 圖的高度(px)。 */
  height?: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
  series: readonly ChartSeries[];
  show: (value: number) => string;
  locale: Locale;
  /** stacked 才有當天合計。 */
  totalLabel?: string;
}

function ChartTooltip({ active, payload, series, show, locale, totalLabel }: TooltipProps) {
  const row = payload?.[0]?.payload as ChartRow | undefined;
  if (!active || !row) return null;
  return (
    <div className="flex min-w-40 flex-col gap-1.5 rounded-[calc(10px*var(--admin-radius-scale,1))] bg-surface px-3 py-2 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_8px_20px_-8px_rgba(30,20,50,0.18))]">
      <div className="text-[11.5px] text-ink/45">{longDay(row.day, locale)}</div>
      {series.map((s, i) => (
        <div key={s.key} className="flex items-center justify-between gap-4 text-[12.5px]">
          <span className="flex min-w-0 items-center gap-1.5 text-ink/60">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColor(i) }} />
            <span className="truncate">{s.label}</span>
          </span>
          <span className="font-medium tabular-nums text-ink/85">{show(row[slotOf(i)] ?? 0)}</span>
        </div>
      ))}
      {totalLabel && series.length > 1 && (
        <div className="flex items-center justify-between gap-4 border-t border-ink/[0.06] pt-1.5 text-[12.5px]">
          <span className="text-ink/60">{totalLabel}</span>
          <span className="font-semibold tabular-nums text-ink/90">{show(row.total)}</span>
        </div>
      )}
    </div>
  );
}

function Legend({ series, show }: { series: readonly ChartSeries[]; show?: (value: number) => string }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
      {series.map((s, i) => {
        const name = s.href ? (
          <AdminLink
            href={s.href}
            className="truncate text-ink/65 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-ink/90 hover:decoration-ink/50 focus-visible:text-ink/90"
          >
            {s.label}
          </AdminLink>
        ) : (
          <span className="truncate text-ink/65">{s.label}</span>
        );
        return (
          <li key={s.key} className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColor(i) }} />
            {name}
            {show && <span className="shrink-0 tabular-nums text-ink/45">{show(pointsTotal(s.days))}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function useAxes(days: readonly string[], empty: boolean, locale: Locale) {
  const ticks = useMemo(() => axisTickDays(days), [days]);
  return [
    <CartesianGrid key="grid" vertical={false} stroke="currentColor" strokeOpacity={0.25} />,
    <XAxis
      key="x"
      dataKey="day"
      interval={0}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      tick={{ fill: "currentColor", fontSize: 11 }}
      tickFormatter={(day: string) => (ticks.has(day) ? shortDay(day) : "")}
    />,
    <YAxis
      key="y"
      width={empty ? 8 : 52}
      tickLine={false}
      axisLine={false}
      tickCount={4}
      allowDecimals={false}
      tick={empty ? false : { fill: "currentColor", fontSize: 11 }}
      tickFormatter={(value: number) => compactNumber(value, locale)}
    />,
  ];
}

export function TimeseriesChart({ data, locale, height = 200 }: TimeseriesChartProps) {
  const t = useT();
  const { days, series, unit, mode } = data;
  const rows = useMemo(() => dailyRows(days, series), [days, series]);
  const empty = rows.every((row) => series.every((_, i) => (row[slotOf(i)] ?? 0) === 0));
  const axes = useAxes(days, empty, locale);
  const show = (value: number) => formatUnit(value, unit, locale);
  const stacked = mode === "stacked";
  const tooltip = (
    <Tooltip
      cursor={stacked ? { fill: "currentColor", fillOpacity: 0.12 } : { stroke: "currentColor", strokeOpacity: 0.3 }}
      isAnimationActive={false}
      content={<ChartTooltip series={series} show={show} locale={locale} totalLabel={stacked ? t("reportChart.dayTotal") : undefined} />}
    />
  );
  // 右邊留半個日期寬:最後一天的日期置中在最後一根長條下,不留就在窄畫面被切掉。
  const common = { data: rows, margin: { top: 4, right: 16, bottom: 0, left: 0 }, accessibilityLayer: true, title: t("reportChart.title", { label: data.label }) };

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full text-ink/40" style={{ height }}>
        <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 640, height }}>
          {stacked ? (
            <BarChart {...common} barCategoryGap={days.length > 45 ? 1 : "22%"}>
              {axes}
              {tooltip}
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={slotOf(i)}
                  name={s.label}
                  stackId="stack"
                  maxBarSize={28}
                  radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
                  isAnimationActive="auto"
                  animationDuration={400}
                >
                  {rows.map((row) => (
                    <Cell key={row.day} style={{ fill: seriesColor(i) }} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          ) : (
            <LineChart {...common}>
              {axes}
              {tooltip}
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  dataKey={slotOf(i)}
                  name={s.label}
                  type="monotone"
                  dot={false}
                  strokeWidth={2}
                  style={{ stroke: seriesColor(i) }}
                  isAnimationActive="auto"
                  animationDuration={400}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {empty && <p className="text-[12.5px] text-ink/45">{t("reportChart.empty", { label: data.label })}</p>}
      <Legend series={series} show={stacked ? show : undefined} />
    </div>
  );
}
