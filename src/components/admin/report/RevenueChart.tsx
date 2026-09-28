"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AdminLink } from "@/components/admin/AdminLink";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n";
import { formatMoney } from "@/ext/commerce-kit/money";
import {
  axisTickDays,
  compactAmount,
  dailyRows,
  longDay,
  seriesColor,
  shortDay,
  slotOf,
  type ChartRow,
  type ChartSeries,
} from "./revenue-summary";

// 1.61.0:每日營業額的疊加長條圖(儀表板的營業額卡、插件的報表頁共用)。
//   - 一天一根,各條線疊在一起;顏色是後台主色的深淺(dashboard/widgets/palette.ts)。
//   - 提示框:那一天的日期、每條線的金額,兩條以上再加當天合計。
//   - 圖例在圖下面:每條線的名字與這段期間的合計;給了 href 的名字連到那一頁。
//   - x 軸 10 天以內每天標,再多大約標 6 個(一定標到最後一天);整段都是 0 時 y 軸不標數字,
//     圖下說一句沒有營業額。
//   - 長條的進場動畫是 recharts 的 "auto":伺服器上不畫、使用者要求減少動態時不動。

export interface RevenueChartProps {
  /** 期間的每一天,舊到新(YYYY-MM-DD)。 */
  days: readonly string[];
  series: readonly ChartSeries[];
  locale: Locale;
  /** 圖的高度(px)。 */
  height?: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
  series: readonly ChartSeries[];
  locale: Locale;
  totalLabel: string;
}

function RevenueTooltip({ active, payload, series, locale, totalLabel }: TooltipProps) {
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
          <span className="font-medium tabular-nums text-ink/85">{formatMoney(row[slotOf(i)] ?? 0)}</span>
        </div>
      ))}
      {series.length > 1 && (
        <div className="flex items-center justify-between gap-4 border-t border-ink/[0.06] pt-1.5 text-[12.5px]">
          <span className="text-ink/60">{totalLabel}</span>
          <span className="font-semibold tabular-nums text-ink/90">{formatMoney(row.total)}</span>
        </div>
      )}
    </div>
  );
}

function Legend({ series, rows }: { series: readonly ChartSeries[]; rows: readonly ChartRow[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
      {series.map((s, i) => {
        const total = rows.reduce((sum, row) => sum + (row[slotOf(i)] ?? 0), 0);
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
            <span className="shrink-0 tabular-nums text-ink/45">{formatMoney(total)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function RevenueChart({ days, series, locale, height = 200 }: RevenueChartProps) {
  const t = useT();
  const rows = useMemo(() => dailyRows(days, series), [days, series]);
  const ticks = useMemo(() => axisTickDays(days), [days]);
  const empty = rows.every((row) => row.total === 0);
  const dense = days.length > 45;

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full text-ink/40" style={{ height }}>
        <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 640, height }}>
          <BarChart
            data={rows}
            // 右邊留半個日期寬:最後一天的日期置中在最後一根長條下,不留就在窄畫面被切掉。
            margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
            barCategoryGap={dense ? 1 : "22%"}
            accessibilityLayer
            title={t("revenue.chart")}
          >
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.25} />
            <XAxis
              dataKey="day"
              interval={0}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={{ fill: "currentColor", fontSize: 11 }}
              tickFormatter={(day: string) => (ticks.has(day) ? shortDay(day) : "")}
            />
            <YAxis
              width={empty ? 8 : 52}
              tickLine={false}
              axisLine={false}
              tickCount={4}
              allowDecimals={false}
              tick={empty ? false : { fill: "currentColor", fontSize: 11 }}
              tickFormatter={(amount: number) => compactAmount(amount, locale)}
            />
            <Tooltip
              cursor={{ fill: "currentColor", fillOpacity: 0.12 }}
              isAnimationActive={false}
              content={<RevenueTooltip series={series} locale={locale} totalLabel={t("revenue.dayTotal")} />}
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={slotOf(i)}
                name={s.label}
                stackId="revenue"
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
        </ResponsiveContainer>
      </div>
      {empty && <p className="text-[12.5px] text-ink/45">{t("revenue.empty")}</p>}
      <Legend series={series} rows={rows} />
    </div>
  );
}
