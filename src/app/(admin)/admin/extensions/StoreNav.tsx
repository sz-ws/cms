"use client";

import type { MouseEvent } from "react";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { categoryLabel, type CategoryCount, type CategoryFilter } from "./store-filter";

// 1.58.0:商店的分類導覽、「只看已安裝」與標籤。
// 分類列在窄螢幕上是可以左右滑的一排(不讓整頁橫向捲動),寬螢幕上換行。

export function CategoryNav({
  counts,
  total,
  active,
  onChange,
}: {
  counts: readonly CategoryCount[];
  total: number;
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  const t = useT();
  const items: { key: CategoryFilter; count: number }[] = [{ key: "all", count: total }, ...counts];
  return (
    <nav aria-label={t("registryBrowser.categories")} className="min-w-0">
      <ul className="no-scrollbar flex gap-1.5 overflow-x-auto overscroll-x-contain py-0.5 sm:flex-wrap sm:overflow-visible">
        {items.map(({ key, count }) => {
          const current = active === key;
          return (
            <li key={key} className="shrink-0">
              <button
                type="button"
                aria-pressed={current}
                onClick={() => onChange(key)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-(--admin-accent)/45 active:scale-[0.97]",
                  current
                    ? "bg-ink text-white"
                    : "bg-ink/[0.045] text-ink/65 hover:bg-ink/[0.08] hover:text-ink/90",
                )}
              >
                {categoryLabel(t, key)}
                <span className={cn("text-[12px] tabular-nums", current ? "text-white/55" : "text-ink/35")}>{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 「只看已安裝」:原生 checkbox,跟搜尋框同高。 */
export function InstalledToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const t = useT();
  return (
    <label
      className={cn(
        "inline-flex h-10 shrink-0 cursor-pointer select-none items-center gap-2 rounded-[calc(10px*var(--admin-radius-scale,1))] border bg-surface px-3 text-[13px] font-medium transition-[border-color,color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-(--admin-accent)/45",
        checked ? "border-ink/30 text-ink/85" : "border-ink/10 text-ink/55 hover:border-ink/20 hover:text-ink/80",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-[var(--admin-accent)] outline-none"
      />
      {t("registryBrowser.installedOnly")}
    </label>
  );
}

/**
 * 標籤。有 onTag 就是按鈕(點了篩選商店;卡片本身點了會開詳情,所以擋住冒泡),
 * 沒有就是純文字。limit = 卡片只列前幾個。
 */
export function TagChips({
  tags,
  limit,
  onTag,
  size = "sm",
}: {
  tags: readonly string[] | undefined;
  limit?: number;
  onTag?: (tag: string) => void;
  size?: "sm" | "md";
}) {
  const shown = (tags ?? []).slice(0, limit ?? tags?.length ?? 0);
  if (shown.length === 0) return null;
  const chip = cn(
    "inline-block max-w-[12rem] truncate rounded-full bg-ink/[0.045] text-ink/55",
    size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12.5px]",
  );
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5">
      {shown.map((tag) => (
        <li key={tag} className="min-w-0">
          {onTag ? (
            <button
              type="button"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onTag(tag);
              }}
              className={cn(
                chip,
                "outline-none transition-[background-color,color] duration-150 hover:bg-(--admin-accent)/10 hover:text-(--admin-accent) focus-visible:ring-2 focus-visible:ring-(--admin-accent)/45",
              )}
            >
              {tag}
            </button>
          ) : (
            <span className={chip}>{tag}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 目前的標籤篩選,按了清掉。 */
export function ActiveTag({ tag, onClear }: { tag: string; onClear: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`${t("registryBrowser.tagFilter", { tag })} · ${t("registryBrowser.clearTag")}`}
      className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-(--admin-accent)/10 pl-2.5 pr-1.5 text-[12.5px] font-medium text-(--admin-accent) outline-none transition-[background-color] duration-150 hover:bg-(--admin-accent)/15 focus-visible:ring-2 focus-visible:ring-(--admin-accent)/45"
    >
      <span className="truncate">{t("registryBrowser.tagFilter", { tag })}</span>
      <X className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}
