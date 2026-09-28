import type { Locale } from "@/lib/i18n";
import { formatDayKey } from "@/lib/report-period";
import { segmentColor } from "./palette";
import type { TimeseriesChartData } from "./types";

// 1.62.0:每日趨勢圖(TimeseriesChart)的純函式,server 與 client 都能 import。
// 1.61.0 時在 components/admin/report/revenue-summary.ts(那裡留著轉接,2.0 拿掉)。

export type ChartSeries = TimeseriesChartData["series"][number];

/** recharts 的一列:一天,每條線一格(s0、s1…,key 裡的字元不一定能當欄位名),加上當天合計。 */
export interface ChartRow {
  day: string;
  total: number;
  [slot: `s${number}`]: number;
}

export const slotOf = (index: number): `s${number}` => `s${index}`;

/** 每一天一列,舊到新。 */
export function dailyRows(days: readonly string[], series: readonly Pick<ChartSeries, "days">[]): ChartRow[] {
  return days.map((day) => {
    const values = series.map((s) => s.days[day] ?? 0);
    return {
      day,
      total: values.reduce((sum, value) => sum + value, 0),
      ...Object.fromEntries(values.map((value, i) => [slotOf(i), value])),
    };
  });
}

/** 每條線的顏色:第一條是主色,之後的拉開深淺(跳過 0.75,跟主色太像)。 */
export function seriesColor(index: number): string {
  return segmentColor(index === 0 ? 0 : index + 1);
}

/** x 軸要標字的那幾天:10 天以內每天都標,再多就大約 6 個,一定標到最後一天(今天)。 */
export function axisTickDays(days: readonly string[]): Set<string> {
  if (days.length <= 10) return new Set(days);
  const step = Math.ceil(days.length / 6);
  return new Set(days.filter((_, i) => (days.length - 1 - i) % step === 0));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 軸上的短日期:9/23。 */
export function shortDay(day: string): string {
  const m = DAY_RE.exec(day);
  return m ? `${Number(m[2])}/${Number(m[3])}` : day;
}

/** 提示框的日期:2026/9/23(週三)(en:Wed, 9/23/2026)。 */
export function longDay(day: string, locale: Locale): string {
  return formatDayKey(day, locale, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
}
