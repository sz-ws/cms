"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

// 1.44.0:select 設定的分頁畫法(presentation: "tabs")。一排分段按鈕,選項可帶標誌;
// 用在「用哪個服務」這種二選一、三選一。語意是 radiogroup:Tab 進來停在選中的那個,
// 左右鍵換選項(同原生 radio)。

export interface SettingTab {
  value: string;
  label: string;
  logo?: string;
}

interface SettingTabsProps {
  id: string;
  labelledBy: string;
  describedBy?: string;
  value: string;
  tabs: SettingTab[];
  invalid?: boolean;
  onChange: (value: string) => void;
}

export function SettingTabs({ id, labelledBy, describedBy, value, tabs, invalid, onChange }: SettingTabsProps) {
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
      className="inline-flex max-w-full flex-wrap gap-1 justify-self-start rounded-[12px] bg-black/[0.04] p-1"
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
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[9px] px-3.5 text-[14px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-out",
              "outline-none focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
              selected
                ? "bg-white text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-black/45 hover:text-black/75",
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
