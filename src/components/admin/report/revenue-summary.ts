import type { Locale } from "@/lib/i18n";
import { segmentColor } from "../dashboard/widgets/palette";

// 1.61.0:每日營業額圖與報表共用的純函式(server 與 client 都能 import)。

/** 圖上的一條:key 跨插件唯一;href 給了,圖例上的名字就連過去。 */
export interface ChartSeries {
  key: string;
  label: string;
  href?: string;
  /** YYYY-MM-DD → 金額;沒列的日子是 0。 */
  days: Readonly<Record<string, number>>;
}

/** recharts 的一列:一天,每條線一格(s0、s1…,key 裡的字元不一定能當欄位名),加上當天合計。 */
export interface ChartRow {
  day: string;
  total: number;
  [slot: `s${number}`]: number;
}

export const slotOf = (index: number): `s${number}` => `s${index}`;

/** 每一天一列,舊到新。 */
export function dailyRows(days: readonly string[], series: readonly ChartSeries[]): ChartRow[] {
  return days.map((day) => {
    const amounts = series.map((s) => s.days[day] ?? 0);
    return {
      day,
      total: amounts.reduce((sum, amount) => sum + amount, 0),
      ...Object.fromEntries(amounts.map((amount, i) => [slotOf(i), amount])),
    };
  });
}

/** 疊起來的顏色:第一條是主色,之後的拉開深淺(跳過 0.75,跟主色太像)。 */
export function seriesColor(index: number): string {
  return segmentColor(index === 0 ? 0 : index + 1);
}

/** x 軸要標字的那幾天:10 天以內每天都標,再多就大約 6 個,一定標到最後一天(今天)。 */
export function axisTickDays(days: readonly string[]): Set<string> {
  if (days.length <= 10) return new Set(days);
  const step = Math.ceil(days.length / 6);
  return new Set(days.filter((_, i) => (days.length - 1 - i) % step === 0));
}

export interface RevenueChange {
  /** 百分比的絕對值,四捨五入到整數。 */
  percent: number;
  direction: "up" | "down" | "flat";
}

/** 跟前一段比;前一段是 0 時比不出百分比,回 null。 */
export function revenueChange(current: number, previous: number): RevenueChange | null {
  if (!(previous > 0)) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  return { percent: Math.abs(percent), direction: percent > 0 ? "up" : percent < 0 ? "down" : "flat" };
}

const localeTag = (locale: Locale) => (locale === "zh-Hant" ? "zh-TW" : "en-US");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD 當作日曆日(不牽涉時區):那天 UTC 正午。 */
function calendarDate(day: string): Date | null {
  const m = DAY_RE.exec(day);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : null;
}

function formatDay(day: string, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  const date = calendarDate(day);
  return date ? new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: "UTC" }).format(date) : day;
}

/** 軸上的短日期:9/23。 */
export function shortDay(day: string): string {
  const m = DAY_RE.exec(day);
  return m ? `${Number(m[2])}/${Number(m[3])}` : day;
}

/** 提示框的日期:2026/9/23 週三(en:Wed, 9/23/2026)。 */
export function longDay(day: string, locale: Locale): string {
  return formatDay(day, locale, { year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
}

/** 期間的寫法:9/1 – 9/30;不是今年或跨年時帶年份。 */
export function periodLabel(from: string, to: string, today: string, locale: Locale): string {
  const withYear = from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== today.slice(0, 4);
  const options: Intl.DateTimeFormatOptions = withYear
    ? { year: "numeric", month: "numeric", day: "numeric" }
    : { month: "numeric", day: "numeric" };
  const a = formatDay(from, locale, options);
  return from === to ? a : `${a} – ${formatDay(to, locale, options)}`;
}

/** 軸上的金額:1.2萬、12K。 */
export function compactAmount(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { notation: "compact", maximumFractionDigits: 1 }).format(amount);
}
