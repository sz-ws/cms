"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// A collapsible folder group in the admin sidebar (mock's `.grp`). The header
// is a real <button>; the chevron rotates. Group labels are small, sentence-case,
// normal-weight — NOT mono and NOT all-caps (house design language / user red line).
//
// 1.40.0:開合狀態由 AdminSidebar 決定(分區可設成只展開目前頁面所在的那一區),
// 這裡只負責畫。

interface AdminNavGroupProps {
  /** Group heading, e.g. "Admin" / "Content" / "Shop". */
  label: string;
  open: boolean;
  onToggle: () => void;
  /**
   * 分區平常收合時(collapse: "active"),標題就是主要的導覽層:字級大一階、箭頭常駐,
   * 不然整條側欄只剩一排淡灰小字,看不出能點。
   */
  prominent?: boolean;
  /** 目前頁面在這一區裡;收合時標題加深,側欄仍看得出你在哪。 */
  holdsActive?: boolean;
  children: ReactNode;
}

export function AdminNavGroup({
  label,
  open,
  onToggle,
  prominent = false,
  holdsActive = false,
  children,
}: AdminNavGroupProps) {
  const panelId = useId();

  return (
    <div className="mt-1.5 first:mt-0" data-slot="admin-nav-group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "group/nav-group flex w-full items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5",
          "transition-colors duration-150 ease-out",
          prominent
            ? cn(
                "h-7 text-[12px] font-medium hover:text-ink/75",
                holdsActive && !open ? "text-ink/80" : "text-ink/45",
              )
            : "py-1 text-[11px] font-normal text-ink/35 hover:text-ink/60",
          // Hide entirely when the sidebar is docked/collapsed (icons only).
          "in-data-[collapsible=dock]:hidden",
        )}
      >
        <span>{label}</span>
        {/* The chevron is an affordance, not a label: on always-open groups it
            shows on hover/focus (and stays while a group is collapsed, so the
            folded state is visible). Four permanent chevrons down the rail is the
            shadcn-sidebar tell — but on groups that start folded it is the only
            sign they open, so there it stays. */}
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-3 transition-[opacity,transform] duration-150 ease-out",
            !open && "-rotate-90",
            prominent || !open
              ? "opacity-55"
              : "opacity-0 group-hover/nav-group:opacity-55 group-focus-visible/nav-group:opacity-55",
          )}
        />
      </button>
      {/* Items stay mounted for a11y focus order; hidden when collapsed. */}
      <div
        id={panelId}
        className={cn("flex flex-col gap-y-0.5 pt-0.5", !open && "hidden")}
      >
        {children}
      </div>
    </div>
  );
}
