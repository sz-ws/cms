"use client";

import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

// 1.44.0:select 設定的分頁畫法(presentation: "tabs")。一排分段按鈕,選項可帶標誌;
// 用在「用哪個服務」這種二選一、三選一。語意是 radiogroup:Tab 進來停在選中的那個,
// 左右鍵換選項(同原生 radio)。

export interface SettingTab {
  value: string;
  label: string;
  logo?: string;
  /** 例:字體選項用它自己的字體寫名字。 */
  labelStyle?: CSSProperties;
}

interface SettingTabsProps {
  id: string;
  labelledBy: string;
  describedBy?: string;
  value: string;
  tabs: SettingTab[];
  invalid?: boolean;
  onChange: (value: string) => void;
  /** list:一列一個選項(選項多、並排會折行時,例如字體)。 */
  layout?: "row" | "list";
}

export function SettingTabs({ id, labelledBy, describedBy, value, tabs, invalid, onChange, layout = "row" }: SettingTabsProps) {
  const group = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.value === value));

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    onChange(tabs[next].value);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }

  return (
    <div
      ref={group}
      id={id}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={cn(
        "max-w-full gap-1 justify-self-start rounded-[calc(12px*var(--admin-radius-scale,1))] bg-ink/[0.04] p-1",
        layout === "list" ? "flex w-full flex-col" : "inline-flex flex-wrap",
      )}
    >
      {tabs.map((tab, index) => {
        const selected = index === selectedIndex && tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={tab.labelStyle}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[calc(9px*var(--admin-radius-scale,1))] px-3.5 text-[14px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-out",
              "outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
              selected
                ? "bg-surface text-ink/85 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.08))]"
                : "text-ink/45 hover:text-ink/75",
            )}
          >
            {tab.logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tab.logo}
                alt=""
                aria-hidden
                className={cn("size-4 shrink-0 transition-opacity duration-150", selected ? "opacity-100" : "opacity-50")}
              />
            )}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
