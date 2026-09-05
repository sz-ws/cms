"use client";

import { useReducer } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/I18nProvider";
import { ChevronUp, ChevronDown, Pencil, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DashboardWidget,
  PROPORTION_PRESETS,
  TREND_PRESETS,
  type ProportionWidgetData,
  type TrendWidgetData,
  type WidgetPresetId,
} from "./widgets";
import {
  INSIGHT_ALLOWED_PRESETS,
  type InsightConfigEntry,
  type InsightWidgetId,
} from "@/lib/dashboard-insights-config";
import {
  initialInsightsEditState,
  insightsEditReducer,
  needsServerData,
} from "./insights-edit";

// roadmap: 「儀表板能不能自己選要放什麼」——composable-dashboard 方向的第一塊
// 真正可編輯的地方(admin/page.tsx 原本的註解就講明拖拉/編輯模式/卡片調色盤
// 是後面的階段)。v1 刻意窄:只有這三張既有 widget 卡(distribution/
// activity/storage)能開關、換 preset(同資料契約家族內)、排序;per-type 內容
// 卡片跟 extension 貢獻的 dashboardCards 不在範圍內(那兩者分別綁真實內容跟已
// 安裝的 extension,「移除」的正確動作是改內容/停用 extension)。排序用上下
// 箭頭,不做自由拖拉——三個項目不值得為了拖放額外扛一個 DnD library。

interface WidgetDataMap {
  activity?: TrendWidgetData;
  distribution: ProportionWidgetData;
  storage?: TrendWidgetData;
  /** null = 拿不到 DB 大小(如 build 期)—— 該卡片直接不渲染。 */
  database: ProportionWidgetData | null;
}

interface DashboardInsightsProps {
  config: InsightConfigEntry[];
  widgetData: WidgetDataMap;
  defaultPresets: Record<InsightWidgetId, WidgetPresetId>;
  /** 設定寫入是 admin only(PUT /api/settings 走 requireAuth("admin"))。
   *  editor 也進得來 /admin,所以入口在這裡就要收掉 —— 否則按下去必吃 403。 */
  canEdit: boolean;
  labels: {
    title: string;
    subtitle: string;
    edit: string;
    done: string;
    cancel: string;
    show: string;
    hide: string;
    moveUp: string;
    moveDown: string;
    style: string;
    empty: string;
    widget: Record<InsightWidgetId, string>;
    preset: Record<string, string>;
  };
}

function resolvedPreset(
  entry: InsightConfigEntry,
  defaultPresets: Record<InsightWidgetId, WidgetPresetId>,
): WidgetPresetId {
  return entry.preset ?? defaultPresets[entry.id];
}

function renderWidget(
  entry: InsightConfigEntry,
  widgetData: WidgetDataMap,
  defaultPresets: Record<InsightWidgetId, WidgetPresetId>,
) {
  const preset = resolvedPreset(entry, defaultPresets);
  if (entry.id === "distribution" || entry.id === "database") {
    const data = widgetData[entry.id];
    if (!data) return null;
    return (
      <DashboardWidget
        preset={preset as (typeof PROPORTION_PRESETS)[number]}
        data={data}
      />
    );
  }
  const data = widgetData[entry.id];
  if (!data) return null;
  return (
    <DashboardWidget
      preset={preset as (typeof TREND_PRESETS)[number]}
      data={data}
    />
  );
}

function EditRow({
  entry,
  index,
  total,
  labels,
  onToggle,
  onMove,
  onPresetChange,
}: {
  entry: InsightConfigEntry;
  index: number;
  total: number;
  labels: DashboardInsightsProps["labels"];
  onToggle: (id: InsightWidgetId) => void;
  onMove: (id: InsightWidgetId, dir: -1 | 1) => void;
  onPresetChange: (id: InsightWidgetId, preset: WidgetPresetId) => void;
}) {
  const allowedPresets = INSIGHT_ALLOWED_PRESETS[entry.id];
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-white px-3 py-2.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-label={labels.moveUp}
          disabled={index === 0}
          onClick={() => onMove(entry.id, -1)}
          className="flex size-5 items-center justify-center rounded-[4px] text-black/35 transition-colors hover:bg-black/[0.04] hover:text-black/70 disabled:pointer-events-none disabled:opacity-25"
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={labels.moveDown}
          disabled={index === total - 1}
          onClick={() => onMove(entry.id, 1)}
          className="flex size-5 items-center justify-center rounded-[4px] text-black/35 transition-colors hover:bg-black/[0.04] hover:text-black/70 disabled:pointer-events-none disabled:opacity-25"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <Switch
        checked={entry.enabled}
        onCheckedChange={() => onToggle(entry.id)}
        size="sm"
      />

      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-black/85">
          {labels.widget[entry.id]}
        </span>
        <span className="text-[11px] text-black/40">
          {entry.enabled ? labels.show : labels.hide}
        </span>
      </div>

      {allowedPresets.length > 1 && (
        <Select
          value={entry.preset ?? allowedPresets[0]}
          onValueChange={(next) => onPresetChange(entry.id, next as WidgetPresetId)}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            {allowedPresets.map((p) => (
              <SelectItem key={p} value={p}>
                {labels.preset[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function DashboardInsights({
  config,
  widgetData,
  defaultPresets,
  canEdit,
  labels,
}: DashboardInsightsProps) {
  const router = useRouter();
  const t = useT();
  const [state, dispatch] = useReducer(
    insightsEditReducer,
    config,
    initialInsightsEditState,
  );
  const localConfig = state.draft;
  // canEdit 是最後一道:即使狀態被弄成 editing,沒有寫入權限就不顯示編輯 UI。
  const editing = state.editing && canEdit;
  const { saving, saveError } = state;

  // 隱藏的 widget 在 server 端根本不查資料；database 也可能因 build 期拿不到
  // D1 meta 而沒有資料。兩者都不佔版面，但編輯模式仍列出完整開關。
  const enabled = localConfig.filter(
    (e) => e.enabled && widgetData[e.id] !== undefined && widgetData[e.id] !== null,
  );
  const [lead, ...rest] = enabled;

  // 全部關掉、又沒有編輯權限:整段不渲染。留下標題加一句「點編輯開啟」對只能看的
  // 人是死路 —— 那顆按鈕根本不在。
  if (!canEdit && enabled.length === 0) return null;

  async function saveEditing() {
    dispatch({ kind: "saveStarted" });
    try {
      const refreshNeeded = needsServerData(localConfig, config);
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: { "core.dashboard.insights": localConfig } }),
      });
      if (!response.ok) throw new Error("settings save failed");
      // Reorder / preset / hide 都由 local state 完整反映，省掉一次全頁 RSC refresh。
      // 只有從 hidden → visible 時，server 才需要補抓先前刻意沒查的 widget data。
      if (refreshNeeded) router.refresh();
      dispatch({ kind: "saveSucceeded" });
    } catch {
      dispatch({ kind: "saveFailed" });
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-black/90">
            {labels.title}
          </h2>
          <p className="text-[13px] text-black/40">{labels.subtitle}</p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-1">
            {/* 取消:編輯模式唯一與存檔無關的出口。存檔失敗(editor 打 PUT 必吃
                403、或斷線)時,沒有這顆就只能整頁重載才離得開。 */}
            {editing && (
              <button
                type="button"
                disabled={saving}
                onClick={() => dispatch({ kind: "cancel", config })}
                className="inline-flex h-9 items-center rounded-[8px] px-3 text-[13px] font-medium text-black/50 transition-colors hover:bg-black/[0.04] hover:text-black/80 disabled:pointer-events-none disabled:opacity-50"
              >
                {labels.cancel}
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                editing ? saveEditing() : dispatch({ kind: "open" })
              }
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3.5 text-[13px] font-medium transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
                editing ? "bg-black text-white hover:bg-black/85" : "bg-black/[0.04] text-black/70 hover:bg-black/[0.07]",
              )}
            >
              {editing ? (
                <Check className="size-3.5" />
              ) : (
                <Pencil className="size-3.5" />
              )}
              {editing ? labels.done : labels.edit}
            </button>
          </div>
        )}
      </div>

      {saveError && <p role="alert" className="text-sm text-destructive">{t("settingsWorkspace.saveFailedError")}</p>}
      {editing ? (
        <fieldset disabled={saving} className="flex flex-col gap-2 rounded-[14px] bg-black/[0.02] p-2">
          {localConfig.map((entry, i) => (
            <EditRow
              key={entry.id}
              entry={entry}
              index={i}
              total={localConfig.length}
              labels={labels}
              onToggle={(id) => dispatch({ kind: "toggle", id })}
              onMove={(id, dir) => dispatch({ kind: "move", id, dir })}
              onPresetChange={(id, preset) =>
                dispatch({ kind: "preset", id, preset })
              }
            />
          ))}
        </fieldset>
      ) : enabled.length === 0 ? (
        <p className="rounded-[14px] bg-black/[0.02] px-4 py-6 text-center text-[13px] text-black/40">
          {labels.empty}
        </p>
      ) : rest.length === 0 ? (
        <div>{renderWidget(lead, widgetData, defaultPresets)}</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            {renderWidget(lead, widgetData, defaultPresets)}
          </div>
          <div className="flex flex-col gap-4 self-start">
            {rest.map((entry) => (
              <div key={entry.id}>
                {renderWidget(entry, widgetData, defaultPresets)}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
