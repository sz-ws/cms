"use client";

import type { KeyboardEvent } from "react";
import type { getMessages } from "@/lib/i18n/index";

// 內容狀態(草稿 / 已發佈)的切換器。泛用 FormView 與插件自己的編輯版面(blog 的
// layout.tsx)共用 —— 兩邊發佈的操作長得一樣,使用者才不用學兩套。

type Messages = ReturnType<typeof getMessages>;

/**
 * Status picker (admin mode) — 兩段式 paper & ink chip 切換器,取代原生 <select>。
 * Tab/Enter/Space/方向鍵 都能用(由 host element 自己負責)。
 */
export type EntryStatus = "draft" | "published";

export function StatusToggle({
  value,
  onChange,
  m,
  disabled = false,
}: {
  value: EntryStatus;
  onChange: (next: EntryStatus) => void;
  m: Messages;
  /** 1.50.0:只能檢視時停用(不能切換、不能聚焦到另一個選項)。 */
  disabled?: boolean;
}) {
  const options: EntryStatus[] = ["draft", "published"];
  const selectedIndex = options.indexOf(value);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(options[(selectedIndex + 1) % options.length]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(options[(selectedIndex - 1 + options.length) % options.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(options[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(options[options.length - 1]);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={m["extForm.admin.entryStatus"]}
      onKeyDown={onKey}
      className="inline-flex rounded-[10px] admin:rounded-[calc(10px*var(--admin-radius-scale,1))] bg-black/[0.04] admin:bg-ink/[0.04] p-0.5"
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={
              "inline-flex h-8 items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 outline-none disabled:cursor-not-allowed disabled:opacity-60 " +
              (active
                ? "bg-white admin:bg-surface text-black/85 admin:text-ink/85 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06))] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)]"
                : "text-black/55 admin:text-ink/55 hover:text-black/85 admin:hover:text-ink/85 focus-visible:text-black/85 admin:focus-visible:text-ink/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)]")
            }
          >
            {opt === "draft"
              ? m["collection.filter.draft"]
              : m["collection.filter.published"]}
          </button>
        );
      })}
    </div>
  );
}
