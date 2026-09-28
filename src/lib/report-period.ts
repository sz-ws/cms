import { createDateFormatter } from "@/lib/datetime";

// 1.61.0:報表的期間(儀表板的營業額卡、插件的報表頁共用)。純函式,server 與 client 都能 import。
//
// 期間放在網址,三個參數(避開 record-search 的 q / from / to —— 那兩個是 epoch ms,
// 而且插件列表頁的頂欄搜尋會讀):
//   ?range=7|30|90                 到今天為止的 7 / 30 / 90 天(含今天)。沒給或不認得 = 30。
//   ?since=YYYY-MM-DD&until=...    自訂:兩天都含。since ≤ until ≤ 今天,最多 366 天。
// 自訂的兩個參數都在且合法時用自訂(range 不看);任何一個不合法 → 退回 range,再不行就 30 天。
//
// 一天是站台時區的 00:00 到隔天 00:00(createDateFormatter 的 dayKey / dayStart),所以
// start / end 是 epoch ms(end 不含),查詢寫 created_at >= start AND created_at < end。
// 日期的加減(前一段、列出每一天)只動日曆日,跟時區無關,用 UTC 算。

export const REPORT_PRESETS = [7, 30, 90] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];
export const DEFAULT_REPORT_PRESET: ReportPreset = 30;
/** 自訂期間最多幾天(一年,閏年也放得下)。 */
export const MAX_REPORT_DAYS = 366;
/** 網址參數的名字。 */
export const REPORT_PARAMS = { range: "range", since: "since", until: "until" } as const;

export interface ReportPeriod {
  /** 7 / 30 / 90;自訂是 "custom"。 */
  preset: ReportPreset | "custom";
  /** 第一天(含),YYYY-MM-DD。 */
  from: string;
  /** 最後一天(含),YYYY-MM-DD。 */
  to: string;
  /** from 當天 00:00(ms,站台時區)。 */
  start: number;
  /** to 隔天 00:00(ms),不含。 */
  end: number;
  /** from 到 to 的每一天,舊到新。 */
  days: string[];
  timeZone: string;
}

/** 網址參數:URLSearchParams、Next 的 searchParams 物件都收。 */
export type PeriodParamsInput =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | string[] | undefined>>;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

function readParam(params: PeriodParamsInput, name: string): string | null {
  if (typeof (params as { get?: unknown }).get === "function") {
    return (params as { get(name: string): string | null }).get(name);
  }
  const value = (params as Readonly<Record<string, string | string[] | undefined>>)[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** YYYY-MM-DD → 那天 UTC 00:00 的 ms;不是真的日期(2026-02-30)回 null。 */
function dayNumber(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** YYYY-MM-DD 加減幾天。 */
export function addDays(day: string, delta: number): string {
  const base = dayNumber(day);
  if (base === null) throw new Error(`not a day: ${day}`);
  return dayOf(base + delta * DAY_MS);
}

/** a 到 b 共幾天(含兩端);b 在 a 前面時是 0 或負數。 */
export function daySpan(from: string, to: string): number {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** 是不是一個真的 YYYY-MM-DD。 */
export function isDayKey(value: unknown): value is string {
  return typeof value === "string" && dayNumber(value) !== null;
}

/** from 到 to 的每一天,舊到新。 */
export function listDays(from: string, to: string): string[] {
  const count = daySpan(from, to);
  return Array.from({ length: Math.max(count, 0) }, (_, i) => addDays(from, i));
}

function build(preset: ReportPeriod["preset"], from: string, to: string, timeZone: string): ReportPeriod {
  const dates = createDateFormatter("en", timeZone);
  return {
    preset,
    from,
    to,
    start: dates.dayStart(from)!,
    end: dates.dayStart(to, true)!,
    days: listDays(from, to),
    timeZone: dates.timeZone,
  };
}

/** 自訂期間合不合法;合法回 null,不合法回原因(期間控制也用它提示)。 */
export function customPeriodProblem(
  since: string,
  until: string,
  today: string,
): "missing" | "order" | "future" | "length" | null {
  if (!isDayKey(since) || !isDayKey(until)) return "missing";
  if (since > until) return "order";
  if (until > today) return "future";
  if (daySpan(since, until) > MAX_REPORT_DAYS) return "length";
  return null;
}

function presetOf(value: string | null): ReportPreset | null {
  return REPORT_PRESETS.find((preset) => String(preset) === value) ?? null;
}

/** 到 today 為止的 N 天(含今天)。 */
export function presetPeriod(preset: ReportPreset, today: string, timeZone: string): ReportPeriod {
  return build(preset, addDays(today, 1 - preset), today, timeZone);
}

/** 網址參數 → 期間。now 是這次請求的時間,「今天」照站台時區算。不合法的參數一律退回預設,不丟例外。 */
export function parseReportPeriod(params: PeriodParamsInput, now: number, timeZone: string): ReportPeriod {
  const today = createDateFormatter("en", timeZone).dayKey(now);
  const since = readParam(params, REPORT_PARAMS.since)?.trim() ?? "";
  const until = readParam(params, REPORT_PARAMS.until)?.trim() ?? "";
  if (since && until && customPeriodProblem(since, until, today) === null) {
    return build("custom", since, until, timeZone);
  }
  const preset = presetOf(readParam(params, REPORT_PARAMS.range)?.trim() ?? null) ?? DEFAULT_REPORT_PRESET;
  return presetPeriod(preset, today, timeZone);
}

/** 緊接在前、一樣長的那一段(比較用)。 */
export function previousPeriod(period: ReportPeriod): ReportPeriod {
  const length = period.days.length;
  const to = addDays(period.from, -1);
  return build(period.preset, addDays(to, 1 - length), to, period.timeZone);
}

/** 帶著這個期間的網址參數(預設的 30 天也寫出來,連到別頁時一樣)。 */
export function reportPeriodParams(period: Pick<ReportPeriod, "preset" | "from" | "to">): Record<string, string> {
  return period.preset === "custom"
    ? { [REPORT_PARAMS.since]: period.from, [REPORT_PARAMS.until]: period.to }
    : { [REPORT_PARAMS.range]: String(period.preset) };
}

/** base 路徑接上期間參數:/admin/ext/shop/report?range=30。 */
export function withReportPeriod(base: string, period: Pick<ReportPeriod, "preset" | "from" | "to">): string {
  return `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(reportPeriodParams(period))}`;
}

/**
 * 一段 from..to 回推成網址上的期間:到今天為止剛好 7 / 30 / 90 天是那個 preset,否則是自訂。
 * 插件的 dashboardRevenue 拿到的是 from / to / now / timeZone,用它把儀表板的期間帶進 href。
 */
export function periodFromRange(range: { from: string; to: string; now: number; timeZone: string }): Pick<ReportPeriod, "preset" | "from" | "to"> {
  const today = createDateFormatter("en", range.timeZone).dayKey(range.now);
  const length = daySpan(range.from, range.to);
  const preset = range.to === today ? REPORT_PRESETS.find((p) => p === length) : undefined;
  return { preset: preset ?? "custom", from: range.from, to: range.to };
}
