// Dashboard widget preset 目錄 —— 從 Suko 提供的三個 seed widget(watermelon
// registry 的 storage/revenue/weekly-engagement)延伸出的正式 preset 家族。
// 兩種資料契約對應兩種鏡頭(佔比 / 趨勢),七款 preset 分別是同一契約的不同
// 呈現方式 —— 換 preset 不用換資料形狀,呼叫端只挑「要哪種鏡頭 + 哪種畫法」。
//
// 這裡刻意窄:preset 元件不知道資料從哪來(core 統計 / extension DB / 未來
// declarative dashboardCards kind:"widget"),只吃這兩個型別。

/** 佔比家族(donut / bar-list / progress-ring / progress-segments)共用契約。 */
export interface ProportionWidgetData {
  label: string;
  segments: { id: string; label: string; value: number }[];
  /** 顯式總量;缺省 = segments 加總。progress-* 只用 segments[0] 對 total 的比例。 */
  total?: number;
  /** progress-* 系列的中心大字/副標;donut/bar-list 不需要(各段自己有標籤)。 */
  valueLabel?: string;
}

/** 趨勢家族(trend-bars / trend-sparkline / stat-simple)共用契約。 */
export interface TrendWidgetData {
  label: string;
  /** 已格式化或原始數字皆可(呼叫端決定要不要加單位)。 */
  value: number | string;
  delta?: { value: number; direction: "up" | "down" | "flat"; caption?: string };
  /** trend-bars / trend-sparkline 用;stat-simple 忽略。 */
  series?: number[];
}

export type WidgetPresetId =
  | "donut"
  | "bar-list"
  | "progress-ring"
  | "progress-segments"
  | "proportion-bar"
  | "trend-bars"
  | "trend-sparkline"
  | "stat-simple";

// as const(非 WidgetPresetId[] 寬型別)讓 index.tsx 的 Record 查找表用字面量
// union 當 key,漏掉任一 preset 會是編譯期錯誤而非執行期才發現。
export const PROPORTION_PRESETS = [
  "donut",
  "bar-list",
  "progress-ring",
  "progress-segments",
  "proportion-bar",
] as const;

export const TREND_PRESETS = ["trend-bars", "trend-sparkline", "stat-simple"] as const;
