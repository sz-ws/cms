"use client";

import { cn } from "@/lib/utils";

// 1.56.0:列表的狀態篩選,可以一次勾好幾個。「全部」在最前面,一個都沒勾時亮著;
// 每個狀態是一格可勾選的按鈕(role="checkbox"),勾到的前面是填了後台主色的小方框。
// 元件只管畫面:勾選結果由 onChange 交回呼叫端寫進網址(lib/status-filter.ts 的
// formatStatusList / toggleStatus)。有 count 的話,名稱後面放筆數。
//
// 外觀沿用 collection 篩選列的分段控制(淺灰底槽 + 選中的白底),插件的列表頁也可以直接用。

export interface StatusMultiFilterOption {
  value: string;
  label: string;
  /** 這個狀態目前有幾筆;省略就不顯示。 */
  count?: number;
}

export interface StatusMultiFilterProps {
  /** 整組的名稱(螢幕報讀用),例如「狀態」。 */
  label: string;
  /** 「全部」那一格的字。 */
  allLabel: string;
  /** 「全部」的筆數;省略就不顯示。 */
  allCount?: number;
  options: readonly StatusMultiFilterOption[];
  /** 勾到的狀態;空陣列 = 全部。 */
  selected: readonly string[];
  onChange: (next: string[]) => void;
}

const SEGMENT =
  "inline-flex h-8 items-center gap-2 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium transition-[background,color,box-shadow] duration-150 active:scale-[0.96]";
const SEGMENT_ON =
  "bg-white admin:bg-surface text-black/90 admin:text-ink/90 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06))]";
const SEGMENT_OFF = "text-black/45 admin:text-ink/45 hover:text-black/70 admin:hover:text-ink/70";

function Count({ value }: { value?: number }) {
  if (value === undefined) return null;
  return <span className="tabular-nums text-black/35 admin:text-ink/35">{value}</span>;
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-3.5 place-items-center rounded-[4px] transition-[background,box-shadow] duration-150",
        checked
          ? "bg-(--admin-accent) text-white"
          : "shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.22)]",
      )}
    >
      {checked ? (
        <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2.5 6.2 5 8.6l4.5-5.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

export function StatusMultiFilter({
  label,
  allLabel,
  allCount,
  options,
  selected,
  onChange,
}: StatusMultiFilterProps) {
  const none = selected.length === 0;
  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
    // 照選項的順序排,同一組條件永遠只有一種網址。
    onChange(options.map((option) => option.value).filter((item) => next.includes(item)));
  };
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex flex-wrap items-center gap-0.5 rounded-[10px] admin:rounded-[calc(10px*var(--admin-radius-scale,1))] bg-black/[0.03] admin:bg-ink/[0.03] p-0.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]"
    >
      <button
        type="button"
        aria-pressed={none}
        onClick={() => {
          if (!none) onChange([]);
        }}
        className={cn(SEGMENT, none ? SEGMENT_ON : SEGMENT_OFF)}
      >
        {allLabel}
        <Count value={allCount} />
      </button>
      {options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role="checkbox"
            aria-checked={checked}
            onClick={() => toggle(option.value)}
            className={cn(SEGMENT, checked ? SEGMENT_ON : SEGMENT_OFF)}
          >
            <CheckBox checked={checked} />
            {option.label}
            <Count value={option.count} />
          </button>
        );
      })}
    </div>
  );
}
