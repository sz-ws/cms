import type { WidgetPresetId } from "@/components/admin/dashboard/widgets/types";

// Dashboard「深入洞察」區的可編輯設定(core.dashboard.insights)。範圍刻意窄:
// 只有這三個既有 widget 卡片(distribution/activity/storage)可以開關、換
// preset(同一資料契約家族內)、排序;per-type 內容卡片與 extension 貢獻的
// dashboardCards 不在這裡管——那兩者分別綁著真實內容資料與已安裝的 extension,
// 「移除」的正確動作是改內容/停用 extension,不是儀表板編輯模式的責任範圍。

export type InsightWidgetId = "activity" | "distribution" | "storage" | "database";

export interface InsightConfigEntry {
  id: InsightWidgetId;
  enabled: boolean;
  /** 缺省 = 呼叫端依資料形狀挑的預設 preset(如 distribution 依 type 數挑 donut/bar-list)。 */
  preset?: WidgetPresetId;
}

export const INSIGHT_WIDGET_IDS: InsightWidgetId[] = [
  "activity",
  "distribution",
  "storage",
  "database",
];

/** 每個 widget 允許換哪些 preset——同一資料契約家族內才能互換(見 widgets/types.ts)。
 *  storage 只給 stat-simple:R2 無固定配額,progress-* 需要一個 total 才有意義,
 *  虛構上限對使用者是誤導(沿用 admin/page.tsx 原本的理由)。
 *  database 相反:D1 配額是真實 hard limit(free 500MB / paid 10GB,超過寫不進去),
 *  progress-* 語意完全成立,預設就給 progress-ring(見 admin/page.tsx)。 */
export const INSIGHT_ALLOWED_PRESETS: Record<InsightWidgetId, WidgetPresetId[]> = {
  activity: ["trend-bars", "trend-sparkline"],
  distribution: ["donut", "bar-list", "progress-ring", "progress-segments", "proportion-bar"],
  storage: ["stat-simple"],
  database: ["progress-ring", "progress-segments", "proportion-bar"],
};

export const DEFAULT_INSIGHT_CONFIG: InsightConfigEntry[] = [
  { id: "activity", enabled: true },
  { id: "distribution", enabled: true },
  { id: "storage", enabled: true },
  { id: "database", enabled: true },
];

/**
 * 存檔設定跟目前已知的 widget id 集合對齊:缺的 id(新裝的 core 版本多了一個
 * widget)補預設值、補在陣列尾端;不認得的 id(未來拿掉某個 widget)直接濾掉。
 * 永遠回傳恰好 INSIGHT_WIDGET_IDS 那些 id、且每個只出現一次。
 */
export function normalizeInsightConfig(raw: unknown): InsightConfigEntry[] {
  const list = Array.isArray(raw) ? (raw as Partial<InsightConfigEntry>[]) : [];
  const known = new Map<InsightWidgetId, InsightConfigEntry>();
  for (const entry of list) {
    if (
      entry &&
      typeof entry === "object" &&
      INSIGHT_WIDGET_IDS.includes(entry.id as InsightWidgetId) &&
      !known.has(entry.id as InsightWidgetId)
    ) {
      known.set(entry.id as InsightWidgetId, {
        id: entry.id as InsightWidgetId,
        enabled: entry.enabled !== false,
        preset: entry.preset,
      });
    }
  }
  const ordered = [...known.values()];
  for (const id of INSIGHT_WIDGET_IDS) {
    if (!known.has(id)) ordered.push({ id, enabled: true });
  }
  return ordered;
}
