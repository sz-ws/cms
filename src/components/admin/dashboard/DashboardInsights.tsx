"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

// roadmap: 「儀表板能不能自己選要放什麼」——composable-dashboard 方向的第一塊
// 真正可編輯的地方(admin/page.tsx 原本的註解就講明拖拉/編輯模式/卡片調色盤
// 是後面的階段)。v1 刻意窄:只有這三張既有 widget 卡(distribution/
// activity/storage)能開關、換 preset(同資料契約家族內)、排序;per-type 內容
// 卡片跟 extension 貢獻的 dashboardCards 不在範圍內(那兩者分別綁真實內容跟已
// 安裝的 extension,「移除」的正確動作是改內容/停用 extension)。排序用上下
// 箭頭,不做自由拖拉——三個項目不值得為了拖放額外扛一個 DnD library。

interface WidgetDataMap {
  activity: TrendWidgetData;
  distribution: ProportionWidgetData;
  storage: TrendWidgetData;
  /** null = 拿不到 DB 大小(如 build 期)—— 該卡片直接不渲染。 */
  database: ProportionWidgetData | null;
}

interface DashboardInsightsProps {
  config: InsightConfigEntry[];
  widgetData: WidgetDataMap;
  defaultPresets: Record<InsightWidgetId, WidgetPresetId>;
  labels: {
    title: string;
    subtitle: string;
    edit: string;
    done: string;
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
  return (
    <DashboardWidget
      preset={preset as (typeof TREND_PRESETS)[number]}
      data={widgetData[entry.id] as TrendWidgetData}
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
  labels,
}: DashboardInsightsProps) {
  const router = useRouter();
  const [localConfig, setLocalConfig] = useState(config);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // database 可能沒有資料(build 期拿不到 D1 meta)—— 沒資料的 widget 不佔
  // 版面(否則 grid 會留一個空格),但編輯模式仍列出(開關設定照存)。
  const enabled = localConfig.filter(
    (e) => e.enabled && !(e.id === "database" && !widgetData.database),
  );
  const [lead, ...rest] = enabled;

  function toggle(id: InsightWidgetId) {
    setLocalConfig((prev) =>
      prev.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)),
    );
  }

  function move(id: InsightWidgetId, dir: -1 | 1) {
    setLocalConfig((prev) => {
      const i = prev.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function changePreset(id: InsightWidgetId, preset: WidgetPresetId) {
    setLocalConfig((prev) =>
      prev.map((e) => (e.id === id ? { ...e, preset } : e)),
    );
  }

  async function finishEditing() {
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: { "core.dashboard.insights": localConfig } }),
      });
      router.refresh();
    } finally {
      setSaving(false);
      setEditing(false);
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
        <button
          type="button"
          disabled={saving}
          onClick={() => (editing ? finishEditing() : setEditing(true))}
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

      {editing ? (
        <div className="flex flex-col gap-2 rounded-[14px] bg-black/[0.02] p-2">
          {localConfig.map((entry, i) => (
            <EditRow
              key={entry.id}
              entry={entry}
              index={i}
              total={localConfig.length}
              labels={labels}
              onToggle={toggle}
              onMove={move}
              onPresetChange={changePreset}
            />
          ))}
        </div>
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
