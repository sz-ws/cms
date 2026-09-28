import { format, type Locale } from "@/lib/i18n";
import { periodChange, pointsTotal } from "@/lib/report-period";
import { formatUnit, localeTag, resolveUnit } from "@/lib/units";
import type { DashboardWidgetsData, WidgetCard } from "@/ext/dx/dashboard-widgets";
import type { NormalizedListItem } from "@/ext/dx/dashboard-widget-data";
import type { ProportionWidgetData, TimeseriesChartData, TrendWidgetData } from "./widgets/types";

// 1.62.0:儀表板上插件的卡片(ext/dx/dashboard-widgets.ts 的 WidgetCard)→ 畫面要的樣子:數字照單位寫好
// (lib/units.ts,金額沒指定幣別的用站台幣別)、比前一段寫成一句、每種卡分開排。伺服器上跑的純函式。

/** 「比前 {days} 天」這幾句的樣板(i18n reportPeriod.*)。 */
export interface ComparisonLabels {
  vsPrevious: string;
  vsPreviousDay: string;
  /** 「前 {days} 天沒有{label}」 */
  noPrevious: string;
  noPreviousDay: string;
}

/** 比前一段:漲跌(DeltaPill),或一句前一段是 0 的話。 */
export type Comparison =
  | { kind: "delta"; delta: NonNullable<TrendWidgetData["delta"]> }
  | { kind: "note"; text: string }
  | null;

export interface NumberCardModel {
  key: string;
  title: string;
  /** 標題下的小字:插件給的,或插件名稱。 */
  hint: string;
  href?: string;
  value: number;
  /** 照單位寫好的數字;沒有 = 件數,照後台語言寫(會動的數字)。 */
  text?: string;
  comparison: Comparison;
  spark?: number[];
}

export interface TimeseriesCardModel {
  key: string;
  title: string;
  /** 期間合計(加總的卡)。 */
  total?: string;
  comparison: Comparison;
  chart: TimeseriesChartData;
}

export interface ProportionCardModel {
  key: string;
  preset: "donut" | "bar-list";
  data: ProportionWidgetData;
}

export interface ListCardModel {
  key: string;
  title: string;
  hint: string;
  href?: string;
  items: NormalizedListItem[];
}

export interface PluginCards {
  numbers: NumberCardModel[];
  timeseries: TimeseriesCardModel[];
  proportions: ProportionCardModel[];
  lists: ListCardModel[];
}

export interface CardFormat {
  locale: Locale;
  /** 站台幣別(core.currency)。 */
  currency: string;
  labels: ComparisonLabels;
}

/** 跟前一段比的那一句;不比較時 null。 */
function comparisonOf(total: number, previous: number | null | undefined, days: number, label: string, labels: ComparisonLabels): Comparison {
  if (previous === null || previous === undefined) return null;
  const change = periodChange(total, previous);
  if (change) {
    const caption = days === 1 ? labels.vsPreviousDay : format(labels.vsPrevious, { days });
    return { kind: "delta", delta: { value: change.percent, direction: change.direction, caption } };
  }
  if (total === 0) return null;
  return { kind: "note", text: format(days === 1 ? labels.noPreviousDay : labels.noPrevious, { days, label }) };
}

function names(list: readonly string[], locale: Locale): string {
  return new Intl.ListFormat(localeTag(locale), { style: "long", type: "conjunction" }).format(list);
}

function numberCard(card: WidgetCard, value: number, spark: number[] | undefined, days: number, fmt: CardFormat): NumberCardModel {
  const unit = resolveUnit(card.unit, fmt.currency);
  const text = card.display ?? (unit.kind === "count" ? undefined : formatUnit(value, unit, fmt.locale));
  return {
    key: card.key,
    title: card.title,
    hint: card.hint ?? names(card.extNames, fmt.locale),
    ...(card.href ? { href: card.href } : {}),
    value,
    ...(text !== undefined ? { text } : {}),
    comparison: comparisonOf(value, card.previous, days, card.title, fmt.labels),
    ...(spark ? { spark } : {}),
  };
}

function timeseriesCard(card: WidgetCard, series: Extract<WidgetCard["data"], { kind: "timeseries" }>["series"], periodDays: string[], fmt: CardFormat): TimeseriesCardModel {
  const unit = resolveUnit(card.unit, fmt.currency);
  const stacked = card.combine === "sum";
  const total = series.reduce((sum, s) => sum + pointsTotal(s.points), 0);
  return {
    key: card.key,
    title: card.title,
    ...(stacked ? { total: formatUnit(total, unit, fmt.locale) } : {}),
    comparison: stacked ? comparisonOf(total, card.previous, periodDays.length, card.title, fmt.labels) : null,
    chart: {
      label: card.title,
      days: periodDays,
      series: series.map((s) => ({ key: s.key, label: s.label, ...(s.href ? { href: s.href } : {}), days: s.points })),
      unit,
      mode: stacked ? "stacked" : "overlay",
    },
  };
}

function proportionCard(card: WidgetCard, data: Extract<WidgetCard["data"], { kind: "proportion" }>, fmt: CardFormat): ProportionCardModel {
  const unit = resolveUnit(card.unit, fmt.currency);
  const show = (value: number) => formatUnit(value, unit, fmt.locale);
  const total = data.total ?? data.segments.reduce((sum, s) => sum + s.value, 0);
  return {
    key: card.key,
    // 同核心的內容分佈:四段以內用 donut,再多切太細,改 bar-list。
    preset: data.segments.length > 4 ? "bar-list" : "donut",
    data: {
      label: card.title,
      segments: data.segments.map((s) => ({ id: s.key, label: s.label, value: s.value, display: show(s.value) })),
      ...(data.total !== undefined ? { total: data.total } : {}),
      totalDisplay: show(total),
    },
  };
}

/** 插件的卡片分成四排,每排照插件、再照宣告的順序。 */
export function buildPluginCards(widgets: DashboardWidgetsData, fmt: CardFormat): PluginCards {
  const periodDays = widgets.period?.days ?? [];
  const empty: PluginCards = { numbers: [], timeseries: [], proportions: [], lists: [] };
  return widgets.cards.reduce((acc, card): PluginCards => {
    const { data } = card;
    switch (data.kind) {
      case "number":
        return { ...acc, numbers: [...acc.numbers, numberCard(card, data.value, data.spark, periodDays.length, fmt)] };
      case "timeseries":
        return { ...acc, timeseries: [...acc.timeseries, timeseriesCard(card, data.series, periodDays, fmt)] };
      case "proportion":
        return { ...acc, proportions: [...acc.proportions, proportionCard(card, data, fmt)] };
      default: {
        const list: ListCardModel = { key: card.key, title: card.title, hint: card.hint ?? names(card.extNames, fmt.locale), ...(card.href ? { href: card.href } : {}), items: data.items };
        return { ...acc, lists: [...acc.lists, list] };
      }
    }
  }, empty);
}
