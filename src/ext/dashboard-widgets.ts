import { z } from "zod";
import type { LocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";
import { isCurrencyCode, type Unit } from "@/lib/units";
import { CONTROL_RE, isAdminHref } from "./dx/dashboard-hook";

// 1.62.0:插件放在儀表板上的東西(Extension.dashboardWidgets 與 Extension.metrics)。
//
// 一個 widget 是一張卡:插件宣告它是哪一種(number / timeseries / proportion / list)、標題、連到哪一頁、
// 數字的單位,core 每次打開儀表板呼叫 load() 拿資料,驗過之後照種類畫。core 管的事:
//   - 期間:`period: true` 的 widget 拿到儀表板的期間(整頁一個期間控制,網址 ?range= / ?since=&until=,
//     lib/report-period.ts);加總的數字與每日圖,core 另外問一次前一段,算出比前一段。
//   - 合併:宣告同一個 metric 的 widget(可以來自不同插件)畫成一張卡 —— 例如兩個插件各自的每日金額
//     疊成一張長條圖。metric 的 key 是 `<namespace>.<name>`,不綁插件 id(幾個插件共用的模組可以匯出
//     一份宣告);widget 用的 metric 要寫在同一個插件的 metrics 裡。兩個插件宣告同一個 key 時要一模一樣
//     (名字、單位、合併方式),不一樣的以先載入的插件為準,後面那個插件在這個 metric 上的 widget 不畫。
//   - 驗證與隔離(dx/dashboard-widgets.ts):丟例外、逾時、回傳的形狀不對 → 這張卡不畫,伺服器記一行,
//     別的照常。看的人打不開的連結、沒有連結的東西(自訂角色與工作人員)不顯示。
//   - 數字的寫法:照 unit(lib/units.ts),金額沒指定幣別時用站台幣別(core.currency)。
//
// 本檔只有形狀與宣告的規則(zod),沒有 React,server 與 client 都能 import。

export type { Unit } from "@/lib/units";

export const WIDGET_KINDS = ["number", "timeseries", "proportion", "list"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** sum:加總(疊起來、有合計、比前一段);overlay:各自畫(線疊在一起,沒有合計)。 */
export type MetricCombine = "sum" | "overlay";

/** 同一個插件內唯一的 widget id,也是一條線、一段、一列的 id 規則。 */
export const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** `<namespace>.<name>`,例:orders.count。 */
const METRIC_KEY_RE = /^[a-z][a-z0-9-]{0,30}\.[a-z][a-z0-9-]{0,40}$/;
export const MAX_DASHBOARD_WIDGETS = 12;
const MAX_METRICS = 8;
const WIDGET_TITLE_MAX = 60;
const WIDGET_HINT_MAX = 80;
/** metric 的名字、一條線、一段的名字最多幾字。 */
export const METRIC_LABEL_MAX = 40;
const UNIT_LABEL_MAX = 12;
const MAX_QUANTITY_DECIMALS = 4;

/**
 * 一個大家共用的數字(Extension.metrics)。宣告同一個 metric 的 widget 合成一張卡,標題是 label、
 * 數字照 unit 寫。值不能是負數(負的值讓那一份資料不顯示)。
 */
export interface MetricDecl {
  /** `<namespace>.<name>`,不綁插件 id:例 "orders.count"。 */
  key: string;
  /** 卡片標題(最多 40 字),例:{ "zh-Hant": "訂單數", en: "Orders" }。 */
  label: LocalizedString;
  unit: Unit;
  combine: MetricCombine;
}

/** 一個數字(可附一排小長條,舊到新)。 */
export interface WidgetNumberData {
  kind: "number";
  value: number;
  spark?: number[];
}

/** 每日的幾條線。points:站台時區的日期 YYYY-MM-DD → 值,只能是期間內的日子,沒列的日子是 0。 */
export interface WidgetTimeseriesData {
  kind: "timeseries";
  bucket: "day";
  series: {
    /** 同一個 widget 內唯一(WIDGET_ID_RE)。 */
    id: string;
    /** 圖例上的名字(最多 40 字)。 */
    label: LocalizedString;
    /** 圖例上的名字連到這一頁(/admin 開頭,可帶 query)。 */
    href?: string;
    points: Record<string, number>;
  }[];
}

/** 佔比:幾段(最多 12 段,值 ≥ 0)。total 省略 = 各段加總。 */
export interface WidgetProportionData {
  kind: "proportion";
  segments: { id: string; label: LocalizedString; value: number }[];
  total?: number;
}

/** 幾列(最多 10 列):標題、連到哪一頁、時間(ms,顯示成「3 分鐘前」)。 */
export interface WidgetListData {
  kind: "list";
  items: { id: string; title: string; href?: string; at?: number }[];
}

export type WidgetData = WidgetNumberData | WidgetTimeseriesData | WidgetProportionData | WidgetListData;

/** 儀表板的期間:整天,站台時區。 */
export interface WidgetPeriod {
  /** 第一天(含),YYYY-MM-DD。 */
  from: string;
  /** 最後一天(含),YYYY-MM-DD。 */
  to: string;
  /** from 當天 00:00(ms)。 */
  start: number;
  /** to 隔天 00:00(ms),不含。查詢寫 created_at >= start AND created_at < end。 */
  end: number;
}

/** load() 收到的內容;每個插件、每次呼叫各一份。 */
export interface WidgetContext {
  /** 這次儀表板的時間(ms)。 */
  now: number;
  /** 站台時區(core.timeZone)。 */
  timeZone: string;
  /** 後台語言。 */
  locale: Locale;
  /** 看的人打不打得開這個後台連結;打不開的 core 會丟掉,插件可以先不查。 */
  canOpen: (href: string) => boolean;
  /** `period: true` 的 widget 才有。前一段也用同一個 load 問(比前一段用)。 */
  period?: WidgetPeriod;
}

/**
 * 插件放在儀表板上的一張卡(Extension.dashboardWidgets,一個插件最多 12 張)。
 *
 * 連結與權限:自訂角色與工作人員只看得到連到他打得開的頁的東西 —— 有 href 的 widget 看 href;
 * 沒有 href 的 widget 看每一條線、每一列自己的 href,沒有連結的 number / proportion 只有管理員看得到。
 * 要讓每個看得到儀表板的人都看得到,href 寫 "/admin"。
 */
export interface DashboardWidgetDecl {
  /** 同一個插件內唯一(WIDGET_ID_RE)。 */
  id: string;
  kind: WidgetKind;
  /** 卡片標題(最多 60 字)。沒有 metric 時必填;有 metric 時不寫,標題是 metric 的 label。 */
  title?: LocalizedString;
  /** 標題下的一行小字(最多 80 字);沒給是插件名稱。 */
  hint?: LocalizedString;
  /** 整張卡連到的後台頁(/admin 開頭,可帶 query)。 */
  href?: string;
  /** 數字的單位;有 metric 時用 metric 的。省略 = count。list 沒有單位。 */
  unit?: Unit;
  /**
   * 共用的數字:同一個插件的 metrics 宣告的 key。同一個 metric、同一種卡的 widget(可以來自不同插件)
   * 合成一張,合併方式照 metric 的 combine。沒有 metric 的 widget 當作 sum(多條線疊起來、有合計)。
   */
  metric?: string;
  /** true = 跟著儀表板的期間(ctx.period)。timeseries 一定要 true。 */
  period?: boolean;
  /** 回傳 null = 這次不畫。丟例外、逾時(3 秒)、形狀不對:不畫,伺服器記一行。 */
  load(ctx: WidgetContext): Promise<WidgetData | null>;
}

// ── 宣告的規則(defineExtension 與 dx/dashboard-widgets.ts 共用)────────────────────

const fn = z.custom<(...a: never[]) => unknown>((v) => typeof v === "function", { message: "expected function" });

/** 可在地化的短字:至少一種語言有字,每種語言最多 max 字,沒有控制字元。 */
function localizedText(max: number) {
  const text = z
    .string()
    .max(max, `at most ${max} characters`)
    .refine((value) => !CONTROL_RE.test(value), "no control characters");
  return z.union([
    text.refine((value) => value.trim().length > 0, "must not be empty"),
    z
      .object({ en: text.optional(), "zh-Hant": text.optional() })
      .strict()
      .refine((value) => Object.values(value).some((v) => typeof v === "string" && v.trim().length > 0), "needs text in at least one language"),
  ]);
}

export const unitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count") }).strict(),
  z.object({ kind: z.literal("currency"), code: z.string().refine(isCurrencyCode, "code must be an ISO 4217 currency such as USD").optional() }).strict(),
  z
    .object({
      kind: z.literal("quantity"),
      label: localizedText(UNIT_LABEL_MAX),
      decimals: z.number().int().min(0).max(MAX_QUANTITY_DECIMALS).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("percent") }).strict(),
]);

export const metricDeclSchema = z
  .object({
    key: z.string().regex(METRIC_KEY_RE, "metric key must be <namespace>.<name>, e.g. orders.count"),
    label: localizedText(METRIC_LABEL_MAX),
    unit: unitSchema,
    combine: z.enum(["sum", "overlay"]),
  })
  .strict();

export const dashboardWidgetDeclSchema = z
  .object({
    id: z.string().regex(WIDGET_ID_RE, "invalid widget id"),
    kind: z.enum(WIDGET_KINDS),
    title: localizedText(WIDGET_TITLE_MAX).optional(),
    hint: localizedText(WIDGET_HINT_MAX).optional(),
    href: z.string().refine(isAdminHref, "href must be an admin path (/admin/...)").optional(),
    unit: unitSchema.optional(),
    metric: z.string().regex(METRIC_KEY_RE, "invalid metric key").optional(),
    period: z.boolean().optional(),
    load: fn,
  })
  .strict()
  .superRefine((decl, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (decl.metric === undefined && decl.title === undefined) issue("a widget without a metric needs a title", "title");
    if (decl.metric !== undefined && decl.title !== undefined) issue("a widget with a metric is titled by the metric's label; leave title out", "title");
    if (decl.metric !== undefined && decl.unit !== undefined) issue("a widget with a metric takes the metric's unit; leave unit out", "unit");
    if (decl.kind === "list" && (decl.metric !== undefined || decl.unit !== undefined)) issue("a list widget has no metric or unit", "kind");
    if (decl.kind === "timeseries" && decl.period !== true) issue("a timeseries widget needs period: true", "period");
  });

function withUniqueKeys<T extends z.ZodType<Record<string, unknown>>>(item: T, key: string, max: number) {
  return z
    .array(item)
    .min(1)
    .max(max)
    .superRefine((list, ctx) => {
      const seen = new Set<unknown>();
      list.forEach((entry, index) => {
        if (seen.has(entry[key])) ctx.addIssue({ code: "custom", message: `duplicate ${key} "${String(entry[key])}"`, path: [index, key] });
        seen.add(entry[key]);
      });
    });
}

/** Extension.dashboardWidgets:1–12 張,id 不重複。 */
export const dashboardWidgetsSchema = withUniqueKeys(dashboardWidgetDeclSchema, "id", MAX_DASHBOARD_WIDGETS);
/** Extension.metrics:1–8 個,key 不重複。 */
export const metricsSchema = withUniqueKeys(metricDeclSchema, "key", MAX_METRICS);
