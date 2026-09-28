import type { Extension } from "../types";
import {
  dashboardWidgetDeclSchema,
  MAX_DASHBOARD_WIDGETS,
  metricDeclSchema,
  type DashboardWidgetDecl,
  type MetricCombine,
  type MetricDecl,
  type Unit,
  type WidgetContext,
  type WidgetKind,
} from "../dashboard-widgets";
import { resolveLocalizedString, sameLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";
import { normalizeTimeZone } from "@/lib/datetime";
import { parseReportPeriod, pointsTotal, previousPeriod, type PeriodParamsInput, type ReportPeriod } from "@/lib/report-period";
import { sameUnit } from "@/lib/units";
import { callDashboardLoad } from "./dashboard-hook";
import { normalizeWidgetData, type NormalizedWidgetData } from "./dashboard-widget-data";
import { resolveDashboardCards, type ResolvedDashboardCard } from "./dashboard-cards";
import { legacyStatEntries } from "./dashboard-stats";
import { legacyRevenueMetrics, legacyRevenueWidgets } from "./dashboard-revenue";

// 1.62.0:儀表板上插件的卡片(Extension.dashboardWidgets + metrics;契約在 ../dashboard-widgets.ts)。
//
// 每次打開儀表板:
//   1. 收所有啟用插件宣告的 metric。同一個 key 以第一個宣告它的插件(照插件順序)為準;後面的插件宣告得
//      一樣(名字照每種語言比、單位、合併方式)就是同一個,不一樣 → 那個插件在這個 metric 上的 widget
//      不畫,記一行(寫出兩個插件)。第一個插件與宣告得一樣的插件照常。
//   2. 驗每一個 widget 的宣告(同一份 zod,defineExtension 也用它);不合規則、重複 id、用了自己沒宣告的
//      metric → 不畫,記一行。看的人打不開的(自訂角色與工作人員)→ 不畫、不呼叫、不記 log。
//   3. 有 `period: true` 的 widget 時照網址讀期間(lib/report-period.ts)。同時呼叫每個 load();加總的
//      number 與 timeseries 另外用前一段再問一次(比前一段)。每次呼叫各自隔離(dashboard-hook.ts):丟例外、
//      逾時、回傳的形狀不對 → 不畫,記一行;回 null → 這次不畫。之後驗資料、算前一段時出了錯也只是這一張
//      不畫,記一行。
//   4. 同一個 metric、同一種卡、同樣跟不跟期間的 widget 合成一張(sum:數字相加、線疊在一起;overlay 的
//      timeseries:線放在一起不加總;overlay 的 number / proportion 不合併)。list 不合併。
//   5. 照插件順序、再照宣告順序排;合成的卡在第一個插件的位置。
//
// 同一個插件的卡依序是:宣告式的 dashboardCards 數字卡、舊的 dashboardStats(dashboard-stats.ts)、
// dashboardWidgets、舊的 dashboardRevenue(dashboard-revenue.ts)。宣告式的「最近更新」卡
// (dashboardCards 的 recent)照舊由 dashboard-cards.ts 解析、用自己的卡片畫,另外回傳。

export const DASHBOARD_WIDGET_TIMEOUT_MS = 3000;
const TAG = "[dashboard-widgets]";

/** 合併前的一張卡:一個插件的一個 widget,或舊介面的一個數字。 */
export interface WidgetEntry {
  /** 跨插件唯一:`<extId>:<來源>:<id>`。 */
  key: string;
  extId: string;
  /** 插件名稱(合併後是每個插件的名稱,照順序)。 */
  extNames: string[];
  kind: WidgetKind;
  title: string;
  hint?: string;
  href?: string;
  unit: Unit;
  combine: MetricCombine;
  metric?: string;
  period: boolean;
  data: NormalizedWidgetData;
  /** 前一段的值(加總的 period number);null = 那次拿不到。 */
  previousValue?: number | null;
  /** 前一段每條線的合計(加總的 period timeseries);null = 那次拿不到。 */
  previousSeries?: ReadonlyMap<string, number> | null;
  /** 舊的 dashboardStats 自己寫好的數字。 */
  display?: string;
}

/** 儀表板上的一張卡(合併過)。 */
export interface WidgetCard {
  key: string;
  /** 第一個插件。 */
  extId: string;
  /** 所有插件的名稱,照順序(卡片的小字沒給時用)。 */
  extNames: string[];
  kind: WidgetKind;
  title: string;
  hint?: string;
  href?: string;
  unit: Unit;
  combine: MetricCombine;
  period: boolean;
  data: NormalizedWidgetData;
  /** 前一段的合計:number 是值、timeseries 是這張卡上每條線前一段的合計相加;null = 有一份拿不到,不比較;
   *  沒有這個欄位 = 這張卡不比較。 */
  previous?: number | null;
  display?: string;
}

export interface DashboardWidgetsData {
  /** 有跟著期間的卡時才有。 */
  period: ReportPeriod | null;
  cards: WidgetCard[];
  /** 宣告式 dashboardCards 的「最近更新」卡。 */
  recent: ResolvedDashboardCard[];
}

export interface DashboardWidgetOptions {
  /** 網址參數(期間)。 */
  params: PeriodParamsInput;
  now: number;
  timeZone: string;
  locale: Locale;
  /** 看的人打不打得開;省略 = 全部(管理員)。 */
  canOpen?: (href: string) => boolean;
  /** 宣告式類型 → 列出它的後台頁(dashboardCards 用)。 */
  hrefs?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** 舊的 dashboardStats 的時限。 */
  statsTimeoutMs?: number;
}

/** 第一個宣告某個 key 的插件的宣告。 */
interface ResolvedMetric {
  /** 卡片標題(這次的後台語言)。 */
  label: string;
  decl: MetricDecl;
  extId: string;
}

interface Metrics {
  /** key → 第一個宣告它的插件(照插件順序)的宣告。 */
  first: ReadonlyMap<string, ResolvedMetric>;
  /** 插件 id → 它宣告的 key → 跟第一個宣告一樣嗎(不一樣的,這個插件在它上面的 widget 不畫)。 */
  byExt: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
}

/** 一個要呼叫的 widget;hook 是 log 裡的名字。 */
export interface WidgetSource {
  decl: DashboardWidgetDecl;
  hook: string;
}

interface WidgetRequest {
  ext: Extension;
  extName: string;
  source: WidgetSource;
  title: string;
  hint?: string;
  unit: Unit;
  combine: MetricCombine;
  metric?: string;
}

interface CallEnv {
  base: Omit<WidgetContext, "period">;
  restricted: boolean;
  timeoutMs: number;
}

const log = (extId: string, message: string) => console.error(`${TAG} ext="${extId}" ${message}`);
const extNameOf = (ext: Extension, locale: Locale) => resolveLocalizedString(ext.name, locale) ?? ext.id;

function sameMetric(a: MetricDecl, b: MetricDecl): boolean {
  return a.combine === b.combine && sameUnit(a.unit, b.unit) && sameLocalizedString(a.label, b.label);
}

/** 1. 所有啟用插件宣告的 metric:第一個宣告為準,每個插件記下自己宣告的 key 能不能用。 */
function collectMetrics(exts: readonly Extension[], locale: Locale): Metrics {
  const first = new Map<string, ResolvedMetric>();
  const byExt = new Map<string, Map<string, boolean>>();
  for (const ext of exts) {
    const own = new Map<string, boolean>();
    for (const decl of [...(ext.metrics ?? []), ...legacyRevenueMetrics(ext)]) {
      const parsed = metricDeclSchema.safeParse(decl);
      if (!parsed.success) {
        log(ext.id, `metric ${JSON.stringify((decl as { key?: unknown }).key ?? null)} is not valid (${parsed.error.issues[0]?.message}); skipped`);
        continue;
      }
      if (own.has(decl.key)) continue;
      const existing = first.get(decl.key);
      if (!existing) first.set(decl.key, { label: resolveLocalizedString(decl.label, locale) ?? decl.key, decl, extId: ext.id });
      const same = !existing || sameMetric(existing.decl, decl);
      if (!same) log(ext.id, `declares metric "${decl.key}" differently from "${existing.extId}", which comes first; its widgets on it are skipped`);
      own.set(decl.key, same);
    }
    byExt.set(ext.id, own);
  }
  return { first, byExt };
}

/** 看的人看不看得到這個 widget(呼叫之前判斷)。沒有 href 的 number / proportion 只有管理員看得到。 */
function viewable(decl: DashboardWidgetDecl, canOpen: DashboardWidgetOptions["canOpen"]): boolean {
  if (!canOpen) return true;
  if (decl.href !== undefined) return canOpen(decl.href);
  return decl.kind === "timeseries" || decl.kind === "list";
}

/** 2. 一個插件要呼叫的 widget:驗過宣告、有 metric、看的人看得到。 */
function widgetRequests(ext: Extension, metrics: Metrics, opts: DashboardWidgetOptions): WidgetRequest[] {
  const own: WidgetSource[] = (ext.dashboardWidgets ?? []).map((decl) => ({ decl, hook: `dashboardWidgets["${String(decl?.id)}"]` }));
  const sources = [...own, ...legacyRevenueWidgets(ext)];
  if (sources.length > MAX_DASHBOARD_WIDGETS) log(ext.id, `declares ${sources.length} widgets; only the first ${MAX_DASHBOARD_WIDGETS} are drawn`);
  const extName = extNameOf(ext, opts.locale);
  const ownMetrics = metrics.byExt.get(ext.id);
  const seen = new Set<string>();
  return sources.slice(0, MAX_DASHBOARD_WIDGETS).flatMap((source, index): WidgetRequest[] => {
    const parsed = dashboardWidgetDeclSchema.safeParse(source.decl);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      log(ext.id, `widget[${index}] ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "is not valid"}; skipped`);
      return [];
    }
    const decl = source.decl;
    if (seen.has(decl.id)) {
      log(ext.id, `widget[${index}] repeats id "${decl.id}"; skipped`);
      return [];
    }
    seen.add(decl.id);
    const usable = decl.metric === undefined ? true : ownMetrics?.get(decl.metric);
    if (usable === undefined) {
      log(ext.id, `widget "${decl.id}" uses metric "${decl.metric}", which this plugin does not declare; skipped`);
      return [];
    }
    // 宣告得跟第一個不一樣:collectMetrics 記過一行了。
    if (!usable) return [];
    const metric = decl.metric === undefined ? undefined : metrics.first.get(decl.metric);
    if (!viewable(decl, opts.canOpen)) return [];
    return [
      {
        ext,
        extName,
        source,
        title: metric?.label ?? resolveLocalizedString(decl.title, opts.locale)?.trim() ?? decl.id,
        hint: resolveLocalizedString(decl.hint, opts.locale)?.trim() || undefined,
        unit: metric?.decl.unit ?? decl.unit ?? { kind: "count" },
        combine: metric?.decl.combine ?? "sum",
        ...(decl.metric !== undefined ? { metric: decl.metric } : {}),
      },
    ];
  });
}

/** 呼叫一次 load():驗過的資料;null = 插件說這次不畫;"failed" = 失敗(已記 log)。 */
async function loadOnce(request: WidgetRequest, period: ReportPeriod | null, env: CallEnv): Promise<NormalizedWidgetData | null | "failed"> {
  const { decl, hook } = request.source;
  const extId = request.ext.id;
  const ctx: WidgetContext = {
    ...env.base,
    ...(period ? { period: { from: period.from, to: period.to, start: period.start, end: period.end } } : {}),
  };
  const result = await callDashboardLoad({ tag: TAG, extId, hook, timeoutMs: env.timeoutMs, call: () => decl.load(ctx) });
  if (!result) return "failed";
  if (result.value === null) return null;
  const data = normalizeWidgetData(decl.kind, result.value, {
    locale: env.base.locale,
    ...(period ? { period } : {}),
    ...(env.restricted ? { canOpen: env.base.canOpen } : {}),
    widgetHasHref: decl.href !== undefined,
    keyPrefix: `${extId}/${decl.id}`,
    log: (message) => log(extId, `${hook} ${message}`),
  });
  if (typeof data === "string") {
    log(extId, `${hook} ${data}; skipped`);
    return "failed";
  }
  return data;
}

function comparesPeriods(request: WidgetRequest): boolean {
  const { kind, period } = request.source.decl;
  return period === true && request.combine === "sum" && (kind === "number" || kind === "timeseries");
}

/** 3. 這一段(與前一段)的資料 → 一張卡;不畫的回 null。 */
async function loadRequest(request: WidgetRequest, period: ReportPeriod | null, env: CallEnv): Promise<WidgetEntry | null> {
  const { decl } = request.source;
  const own = decl.period ? period : null;
  // 前一段先算好:算不出來(丟例外)時一次都還沒呼叫。
  const earlier = comparesPeriods(request) && own ? previousPeriod(own) : null;
  const [current, before] = await Promise.all([
    loadOnce(request, own, env),
    earlier ? loadOnce(request, earlier, env) : Promise.resolve(undefined),
  ]);
  if (current === null || current === "failed") return null;
  if (current.kind === "timeseries" && current.series.length === 0) return null;
  if (current.kind === "list" && current.items.length === 0 && env.restricted && decl.href === undefined) return null;
  const previous = before === undefined ? {} : previousOf(current, before);
  return {
    key: `${request.ext.id}:widget:${decl.id}`,
    extId: request.ext.id,
    extNames: [request.extName],
    kind: decl.kind,
    title: request.title,
    ...(request.hint ? { hint: request.hint } : {}),
    ...(decl.href !== undefined ? { href: decl.href } : {}),
    unit: request.unit,
    combine: request.combine,
    ...(request.metric ? { metric: request.metric } : {}),
    period: decl.period === true,
    data: current,
    ...previous,
  };
}

/** loadRequest,但任何出錯(驗資料、算前一段)都只是這一張不畫,記一行;永遠不 reject。 */
async function loadRequestSafely(request: WidgetRequest, period: ReportPeriod | null, env: CallEnv): Promise<WidgetEntry | null> {
  try {
    return await loadRequest(request, period, env);
  } catch (error) {
    log(request.ext.id, `${request.source.hook} could not be drawn (${error instanceof Error ? error.message : String(error)}); skipped`);
    return null;
  }
}

function previousOf(current: NormalizedWidgetData, before: NormalizedWidgetData | null | "failed"): Pick<WidgetEntry, "previousValue" | "previousSeries"> {
  const usable = before === null || before === "failed" || before.kind !== current.kind ? null : before;
  if (current.kind === "number") return { previousValue: usable?.kind === "number" ? usable.value : null };
  if (usable?.kind !== "timeseries") return { previousSeries: null };
  return { previousSeries: new Map(usable.series.map((series) => [series.key, pointsTotal(series.points)])) };
}

/** 宣告式 dashboardCards 的數字卡 → 一張 number 卡(件數)。 */
function statCardEntry(card: ResolvedDashboardCard, index: number): WidgetEntry {
  return {
    key: `${card.extId}:card:${index}`,
    extId: card.extId,
    extNames: [card.extName],
    kind: "number",
    title: card.title,
    href: card.adminHref,
    unit: { kind: "count" },
    combine: "sum",
    period: false,
    data: { kind: "number", value: card.count ?? 0 },
  };
}

// ── 4. 合併 ──────────────────────────────────────────────────────────────────────

function mergeKey(entry: WidgetEntry): string {
  const mergeable = entry.metric !== undefined && entry.kind !== "list" && (entry.combine === "sum" || entry.kind === "timeseries");
  return mergeable ? `metric:${entry.metric}:${entry.kind}:${entry.period ? "period" : "now"}` : entry.key;
}

function sumOrNull(a: number | null | undefined, b: number | null | undefined): number | null | undefined {
  if (a === undefined && b === undefined) return undefined;
  return typeof a === "number" && typeof b === "number" ? a + b : null;
}

function mergeData(a: NormalizedWidgetData, b: NormalizedWidgetData): NormalizedWidgetData {
  if (a.kind === "number" && b.kind === "number") {
    const spark = a.spark && b.spark && a.spark.length === b.spark.length ? a.spark.map((v, i) => v + b.spark![i]) : undefined;
    return { kind: "number", value: a.value + b.value, ...(spark ? { spark } : {}) };
  }
  if (a.kind === "timeseries" && b.kind === "timeseries") return { kind: "timeseries", series: [...a.series, ...b.series] };
  if (a.kind === "proportion" && b.kind === "proportion") {
    const total = a.total !== undefined && b.total !== undefined ? a.total + b.total : undefined;
    return { kind: "proportion", segments: [...a.segments, ...b.segments], ...(total !== undefined ? { total } : {}) };
  }
  return a;
}

function mergeSeriesTotals(a: WidgetEntry["previousSeries"], b: WidgetEntry["previousSeries"]): WidgetEntry["previousSeries"] {
  if (a === undefined && b === undefined) return undefined;
  if (!a || !b) return null;
  return new Map([...a, ...b]);
}

function mergeEntries(a: WidgetEntry, b: WidgetEntry): WidgetEntry {
  return {
    ...a,
    extNames: [...new Set([...a.extNames, ...b.extNames])],
    hint: undefined,
    href: undefined,
    data: mergeData(a.data, b.data),
    previousValue: sumOrNull(a.previousValue, b.previousValue),
    previousSeries: mergeSeriesTotals(a.previousSeries, b.previousSeries),
  };
}

/** 這一段畫出來的線,前一段的合計(有任何一條拿不到 → null,少一條的比較會失真)。 */
function previousTotal(entry: WidgetEntry): number | null | undefined {
  if (entry.data.kind === "number") return entry.previousValue;
  if (entry.data.kind !== "timeseries" || entry.previousSeries === undefined) return undefined;
  const totals = entry.previousSeries;
  if (!totals || !entry.data.series.every((series) => totals.has(series.key))) return null;
  return entry.data.series.reduce((sum, series) => sum + (totals.get(series.key) ?? 0), 0);
}

function toCard(entry: WidgetEntry): WidgetCard {
  const previous = previousTotal(entry);
  return {
    key: entry.key,
    extId: entry.extId,
    extNames: entry.extNames,
    kind: entry.kind,
    title: entry.title,
    ...(entry.hint ? { hint: entry.hint } : {}),
    ...(entry.href ? { href: entry.href } : {}),
    unit: entry.unit,
    combine: entry.combine,
    period: entry.period,
    data: entry.data,
    ...(previous !== undefined ? { previous } : {}),
    ...(entry.display !== undefined ? { display: entry.display } : {}),
  };
}

/** 4 + 5:同一個 metric 的合成一張,照順序排。 */
function mergeWidgetEntries(entries: readonly WidgetEntry[]): WidgetCard[] {
  const merged = entries.reduce((acc, entry) => {
    const key = mergeKey(entry);
    const existing = acc.get(key);
    return new Map(acc).set(key, existing ? mergeEntries(existing, entry) : entry);
  }, new Map<string, WidgetEntry>());
  return [...merged.values()].map(toCard);
}

/** 所有啟用插件的儀表板卡片。永遠不 throw;壞掉的那一張不畫。 */
export async function loadDashboardWidgets(exts: readonly Extension[], opts: DashboardWidgetOptions): Promise<DashboardWidgetsData> {
  const timeZone = normalizeTimeZone(opts.timeZone);
  const env: CallEnv = {
    base: { now: opts.now, timeZone, locale: opts.locale, canOpen: opts.canOpen ?? (() => true) },
    restricted: opts.canOpen !== undefined,
    timeoutMs: opts.timeoutMs ?? DASHBOARD_WIDGET_TIMEOUT_MS,
  };
  const metrics = collectMetrics(exts, opts.locale);
  const requests = exts.map((ext) => widgetRequests(ext, metrics, opts));
  const period = requests.flat().some((r) => r.source.decl.period) ? parseReportPeriod(opts.params, opts.now, timeZone) : null;
  const [declared, stats, loaded] = await Promise.all([
    resolveDashboardCards([...exts], opts.locale, { hrefs: opts.hrefs, canOpen: opts.canOpen }),
    Promise.all(exts.map((ext) => legacyStatEntries(ext, env.base, opts.statsTimeoutMs))),
    Promise.all(requests.map((list) => Promise.all(list.map((request) => loadRequestSafely(request, period, env))))),
  ]);
  const entries = exts.flatMap((ext, i) => [
    ...declared.filter((card) => card.extId === ext.id && card.kind === "stat").map(statCardEntry),
    ...stats[i],
    ...loaded[i].filter((entry): entry is WidgetEntry => entry !== null),
  ]);
  const cards = mergeWidgetEntries(entries);
  return {
    period: cards.some((card) => card.period) ? period : null,
    cards,
    recent: declared.filter((card) => card.kind === "recent"),
  };
}
