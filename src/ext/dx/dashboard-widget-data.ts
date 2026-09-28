import type { Locale } from "@/lib/i18n/index";
import { isDayKey } from "@/lib/report-period";
import { METRIC_LABEL_MAX, WIDGET_ID_RE, type WidgetKind } from "../dashboard-widgets";
import { INVALID, isAdminHref, readText } from "./dashboard-hook";

// 1.62.0:驗 dashboardWidgets 的 load() 回來的資料(不可信的輸入)。回傳驗過、字串照後台語言解析好的一份
// 新資料,或一句原因(整張卡不畫,呼叫端記 log)。
//
//   number      value 是有限數字;spark 最多 90 個有限數字(多了整張不畫)。
//   timeseries  bucket 是 "day";只看前 4 條(多的不看,記一行),每一條各自驗(id、label ≤ 40、href、
//               points),不合規則的那一條整條丟掉並記一行 —— 只丟一天會讓合計少算,而畫面上看不出來。
//               points 的 key 是期間內真的日期,值是有限數字。重複的 id 留第一條。
//   proportion  1–12 段(多了整張不畫),id 不重複、label ≤ 40;有一段不對整張不畫(少一段的佔比會誤導)。
//   list        只看前 10 列(多的不看,記一行);每一列 id、標題 ≤ 120、href、at 各自驗,壞的那一列丟掉。
//
// 數字一律不能是負的。
// 看的人(rules.canOpen):有 href 的線與列,打不開就不畫;沒有 href 的跟著 widget 自己的 href ——
// widget 也沒有 href 時,自訂角色與工作人員看不到它。不畫、不記 log,那不是插件的錯。

const MAX_SERIES_PER_WIDGET = 4;
const MAX_SEGMENTS = 12;
const MAX_LIST_ITEMS = 10;
const MAX_SPARK_POINTS = 90;

const ITEM_TITLE_MAX = 120;
const ITEM_ID_MAX = 64;

export interface NormalizedSeries {
  /** `<extId>/<widgetId>/<id>`:合成一張卡之後仍然唯一(同一個插件的兩個 widget 也一樣)。 */
  key: string;
  id: string;
  label: string;
  href?: string;
  /** 只有期間內的日子;沒列的是 0。 */
  points: Record<string, number>;
}

export interface NormalizedSegment {
  /** `<extId>/<widgetId>/<id>`,同 NormalizedSeries。 */
  key: string;
  id: string;
  label: string;
  value: number;
}

export interface NormalizedListItem {
  id: string;
  title: string;
  href?: string;
  at?: number;
}

export type NormalizedWidgetData =
  | { kind: "number"; value: number; spark?: number[] }
  | { kind: "timeseries"; series: NormalizedSeries[] }
  | { kind: "proportion"; segments: NormalizedSegment[]; total?: number }
  | { kind: "list"; items: NormalizedListItem[] };

export interface WidgetDataRules {
  locale: Locale;
  /** timeseries 的日子只能在這段裡。 */
  period?: { from: string; to: string };
  /** 看的人打不打得開;省略 = 不受限(管理員)。 */
  canOpen?: (href: string) => boolean;
  /** widget 自己有 href(而且看的人打得開):沒有 href 的線與列跟著它。 */
  widgetHasHref: boolean;
  /** 線與段的 key 前綴:`<extId>/<widgetId>`。 */
  keyPrefix: string;
  /** 丟掉一條線或一列時記一行。 */
  log: (message: string) => void;
}

type Problem = string;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function visible(href: string | undefined, rules: WidgetDataRules): boolean {
  if (!rules.canOpen) return true;
  return href !== undefined ? rules.canOpen(href) : rules.widgetHasHref;
}

/** 選填的 href:沒給 → undefined;給了但不是後台頁 → INVALID。 */
function readHref(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return isAdminHref(value) ? value : INVALID;
}

function checkAmount(value: unknown): Problem | null {
  if (!isFiniteNumber(value)) return "must be a finite number";
  if (value < 0) return "must be at least 0";
  return null;
}

function normalizeNumber(raw: Record<string, unknown>): NormalizedWidgetData | Problem {
  const valueProblem = checkAmount(raw.value);
  if (valueProblem) return `value ${valueProblem}`;
  if (raw.spark === undefined) return { kind: "number", value: raw.value as number };
  if (!Array.isArray(raw.spark) || raw.spark.length > MAX_SPARK_POINTS) return `spark must be a list of at most ${MAX_SPARK_POINTS} numbers`;
  if (raw.spark.some((point) => checkAmount(point) !== null)) return "spark has a value that is not allowed";
  return { kind: "number", value: raw.value as number, spark: [...(raw.spark as number[])] };
}

function readPoints(value: unknown, rules: WidgetDataRules): Record<string, number> | Problem {
  if (!isRecord(value)) return "points must be an object";
  const { from, to } = rules.period ?? { from: "", to: "" };
  const points: Record<string, number> = {};
  for (const [day, amount] of Object.entries(value)) {
    if (!isDayKey(day) || day < from || day > to) return `day "${day.slice(0, 20)}" is not a date from ${from} to ${to}`;
    const problem = checkAmount(amount);
    if (problem) return `day "${day}" ${problem}`;
    points[day] = amount as number;
  }
  return points;
}

function normalizeSeries(entry: unknown, rules: WidgetDataRules): NormalizedSeries | Problem {
  if (!isRecord(entry)) return "is not an object";
  if (typeof entry.id !== "string" || !WIDGET_ID_RE.test(entry.id)) return "has an invalid id";
  const id = entry.id;
  const label = readText(entry.label, rules.locale, METRIC_LABEL_MAX, true);
  if (label === undefined || label === INVALID) return `"${id}" needs a label of at most ${METRIC_LABEL_MAX} characters`;
  const href = readHref(entry.href);
  if (href === INVALID) return `"${id}" href must be an admin path (/admin/...)`;
  const points = readPoints(entry.points, rules);
  if (typeof points === "string") return `"${id}" ${points}`;
  return { key: `${rules.keyPrefix}/${id}`, id, label, ...(href !== undefined ? { href } : {}), points };
}

function normalizeTimeseries(raw: Record<string, unknown>, rules: WidgetDataRules): NormalizedWidgetData | Problem {
  if (raw.bucket !== "day") return 'bucket must be "day"';
  if (!Array.isArray(raw.series)) return "series must be a list";
  if (raw.series.length > MAX_SERIES_PER_WIDGET) {
    rules.log(`returned ${raw.series.length} series; only the first ${MAX_SERIES_PER_WIDGET} are shown`);
  }
  const seen = new Set<string>();
  const series: NormalizedSeries[] = [];
  raw.series.slice(0, MAX_SERIES_PER_WIDGET).forEach((entry, index) => {
    const line = normalizeSeries(entry, rules);
    if (typeof line === "string") return rules.log(`series[${index}] ${line}; dropped`);
    if (seen.has(line.id)) return rules.log(`series[${index}] repeats id "${line.id}"; dropped`);
    seen.add(line.id);
    if (visible(line.href, rules)) series.push(line);
  });
  return { kind: "timeseries", series };
}

function normalizeProportion(raw: Record<string, unknown>, rules: WidgetDataRules): NormalizedWidgetData | Problem {
  if (!Array.isArray(raw.segments) || raw.segments.length === 0 || raw.segments.length > MAX_SEGMENTS) {
    return `segments must be a list of 1 to ${MAX_SEGMENTS}`;
  }
  const segments: NormalizedSegment[] = [];
  for (const [index, entry] of raw.segments.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !WIDGET_ID_RE.test(entry.id)) return `segments[${index}] has an invalid id`;
    const id = entry.id;
    if (segments.some((segment) => segment.id === id)) return `segments[${index}] repeats id "${id}"`;
    const label = readText(entry.label, rules.locale, METRIC_LABEL_MAX, true);
    if (label === undefined || label === INVALID) return `segment "${id}" needs a label of at most ${METRIC_LABEL_MAX} characters`;
    const problem = checkAmount(entry.value);
    if (problem) return `segment "${id}" value ${problem}`;
    segments.push({ key: `${rules.keyPrefix}/${id}`, id, label, value: entry.value as number });
  }
  if (raw.total === undefined) return { kind: "proportion", segments };
  const problem = checkAmount(raw.total);
  return problem ? `total ${problem}` : { kind: "proportion", segments, total: raw.total as number };
}

function normalizeItem(entry: unknown, locale: Locale): NormalizedListItem | Problem {
  if (!isRecord(entry)) return "is not an object";
  const id = readText(entry.id, locale, ITEM_ID_MAX, false);
  if (id === undefined || id === INVALID) return `needs an id of at most ${ITEM_ID_MAX} characters`;
  const title = readText(entry.title, locale, ITEM_TITLE_MAX, false);
  if (title === undefined || title === INVALID) return `"${id}" needs a title of at most ${ITEM_TITLE_MAX} characters`;
  const href = readHref(entry.href);
  if (href === INVALID) return `"${id}" href must be an admin path (/admin/...)`;
  if (entry.at !== undefined && checkAmount(entry.at)) return `"${id}" at must be a time in ms`;
  return { id, title, ...(href !== undefined ? { href } : {}), ...(entry.at !== undefined ? { at: entry.at as number } : {}) };
}

function normalizeList(raw: Record<string, unknown>, rules: WidgetDataRules): NormalizedWidgetData | Problem {
  if (!Array.isArray(raw.items)) return "items must be a list";
  if (raw.items.length > MAX_LIST_ITEMS) rules.log(`returned ${raw.items.length} items; only the first ${MAX_LIST_ITEMS} are shown`);
  const seen = new Set<string>();
  const items: NormalizedListItem[] = [];
  raw.items.slice(0, MAX_LIST_ITEMS).forEach((entry, index) => {
    const item = normalizeItem(entry, rules.locale);
    if (typeof item === "string") return rules.log(`items[${index}] ${item}; dropped`);
    if (seen.has(item.id)) return rules.log(`items[${index}] repeats id "${item.id}"; dropped`);
    seen.add(item.id);
    if (visible(item.href, rules)) items.push(item);
  });
  return { kind: "list", items };
}

/** 驗一次 load() 的結果。null 由呼叫端先處理(這次不畫)。 */
export function normalizeWidgetData(kind: WidgetKind, raw: unknown, rules: WidgetDataRules): NormalizedWidgetData | Problem {
  if (!isRecord(raw)) return "returned something that is not an object";
  if (raw.kind !== kind) return `returned kind "${String(raw.kind).slice(0, 20)}", expected "${kind}"`;
  switch (kind) {
    case "number":
      return normalizeNumber(raw);
    case "timeseries":
      return normalizeTimeseries(raw, rules);
    case "proportion":
      return normalizeProportion(raw, rules);
    default:
      return normalizeList(raw, rules);
  }
}
