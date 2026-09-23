"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { ACCESS_LEVELS, type AccessLevel, type GrantedLevel } from "@/ext/admin-access";
import { useT } from "@/lib/i18n/I18nProvider";

// 角色矩陣的一格:無／檢視／編輯。SettingTabs 的分段按鈕縮成列高(h-7),三段等寬,
// 整張表的欄位上下對齊。語意是 radiogroup:Tab 停在選中的那段,左右鍵換。
//
// value = null:分區標題列的「混合」狀態(底下的頁不一樣),一段都不亮,按了就整區套用。

const LABEL = {
  none: "roles.level.none",
  view: "roles.level.view",
  edit: "roles.level.edit",
} as const;

export function AccessSegmented({
  value,
  max = "edit",
  disabled,
  label,
  onChange,
  quiet,
}: {
  value: AccessLevel | null;
  /** 這一頁最多能給到哪一級;超過的那段畫成停用。 */
  max?: GrantedLevel;
  /** 預設角色:唯讀。 */
  disabled?: boolean;
  label: string;
  onChange?: (level: AccessLevel) => void;
  /** 分區標題列:底色再淡一階,與逐頁的列分開。 */
  quiet?: boolean;
}) {
  const t = useT();
  const group = useRef<HTMLDivElement>(null);
  const allowed = (level: AccessLevel) => level !== "edit" || max === "edit";
  const options = ACCESS_LEVELS;
  const focusIndex = Math.max(0, value === null ? 0 : options.indexOf(value));

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    let next = index;
    for (let i = 0; i < options.length; i++) {
      next = (next + step + options.length) % options.length;
      if (allowed(options[next])) break;
    }
    onChange?.(options[next]);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex shrink-0 gap-0.5 rounded-[calc(9px*var(--admin-radius-scale,1))] p-0.5",
        quiet ? "bg-ink/[0.025]" : "bg-ink/[0.045]",
      )}
    >
      {options.map((level, index) => {
        const selected = value === level;
        const unavailable = !allowed(level);
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={unavailable || disabled || undefined}
            disabled={unavailable || disabled}
            tabIndex={index === focusIndex ? 0 : -1}
            title={unavailable ? t("roles.viewOnlyPage") : undefined}
            onClick={() => onChange?.(level)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-7 w-12 items-center justify-center rounded-[calc(7px*var(--admin-radius-scale,1))] text-[12.5px] font-medium",
              "transition-[background-color,color,box-shadow,transform] duration-150 ease-out outline-none",
              "focus-visible:shadow-[0_0_0_2px_var(--admin-accent)]",
              selected
                ? cn(
                    "bg-surface shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.08))]",
                    level === "edit"
                      ? "text-[color-mix(in_srgb,var(--admin-accent)_82%,black)]"
                      : level === "view"
                        ? "text-ink/80"
                        : "text-ink/55",
                  )
                : unavailable
                  ? "cursor-not-allowed text-ink/20"
                  : disabled
                    ? "text-ink/25"
                    : "text-ink/40 hover:text-ink/75 active:scale-[0.96]",
            )}
          >
            {t(LABEL[level])}
          </button>
        );
      })}
    </div>
  );
}
