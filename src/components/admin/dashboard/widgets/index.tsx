import { DonutWidget } from "./DonutWidget";
import { BarListWidget } from "./BarListWidget";
import { ProgressRing, ProgressRingWidget } from "./ProgressRingWidget";
import { ProgressSegmentsWidget } from "./ProgressSegmentsWidget";
import { ProportionBar, ProportionBarWidget } from "./ProportionBarWidget";
import { TrendBarsWidget } from "./TrendBarsWidget";
import { TrendSparklineWidget } from "./TrendSparklineWidget";
import { StatSimpleWidget } from "./StatSimpleWidget";
import {
  PROPORTION_PRESETS,
  TREND_PRESETS,
  type ProportionWidgetData,
  type TrendWidgetData,
  type WidgetPresetId,
} from "./types";

export * from "./types";
export {
  DonutWidget,
  BarListWidget,
  ProgressRing,
  ProgressRingWidget,
  ProgressSegmentsWidget,
  ProportionBar,
  ProportionBarWidget,
  TrendBarsWidget,
  TrendSparklineWidget,
  StatSimpleWidget,
};

// 「preset 可以被呼叫」的核心:一個 id → component 的查找表。呼叫端(core
// dashboard 或未來 declarative dashboardCards kind:"widget" 的 resolver)只
// 需要知道一個字串 id + 對應資料契約,不用 import 七個元件自己判斷。
const PROPORTION_REGISTRY: Record<
  (typeof PROPORTION_PRESETS)[number],
  React.ComponentType<{ data: ProportionWidgetData }>
> = {
  donut: DonutWidget,
  "bar-list": BarListWidget,
  "progress-ring": ProgressRingWidget,
  "progress-segments": ProgressSegmentsWidget,
  "proportion-bar": ProportionBarWidget,
};

const TREND_REGISTRY: Record<
  (typeof TREND_PRESETS)[number],
  React.ComponentType<{ data: TrendWidgetData }>
> = {
  "trend-bars": TrendBarsWidget,
  "trend-sparkline": TrendSparklineWidget,
  "stat-simple": StatSimpleWidget,
};

function isProportionPreset(
  id: WidgetPresetId,
): id is (typeof PROPORTION_PRESETS)[number] {
  return (PROPORTION_PRESETS as readonly string[]).includes(id);
}

/**
 * 依 preset id 渲染對應 widget。資料型別由 preset 所屬家族決定(佔比 vs 趨勢)
 * ——呼叫端傳錯家族的資料形狀會在型別層被擋下,不是 runtime 才發現。
 */
export function DashboardWidget({
  preset,
  data,
}: {
  preset: WidgetPresetId;
} & (
  | { preset: (typeof PROPORTION_PRESETS)[number]; data: ProportionWidgetData }
  | { preset: (typeof TREND_PRESETS)[number]; data: TrendWidgetData }
)) {
  if (isProportionPreset(preset)) {
    const Widget = PROPORTION_REGISTRY[preset];
    return <Widget data={data as ProportionWidgetData} />;
  }
  const Widget = TREND_REGISTRY[preset as (typeof TREND_PRESETS)[number]];
  return <Widget data={data as TrendWidgetData} />;
}
