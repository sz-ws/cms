"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// A collapsible folder group in the admin sidebar (mock's `.grp`). The header
// is a real <button> that toggles client-only collapse state; the chevron
// rotates. Group labels are small, sentence-case, normal-weight — NOT mono and
// NOT all-caps (house design language / user red line).

interface AdminNavGroupProps {
  /** Group heading, e.g. "Admin" / "Content" / "Shop". */
  label: string;
  /** Whether the group starts expanded. */
  defaultOpen?: boolean;
  children: ReactNode;
}

export function AdminNavGroup({
  label,
  defaultOpen = true,
  children,
}: AdminNavGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-1.5 first:mt-0" data-slot="admin-nav-group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[8px] px-2.5 py-1.5",
          "text-[11.5px] font-normal text-black/40",
          "transition-colors duration-150 ease-out hover:text-black/60",
          // Hide entirely when the sidebar is docked/collapsed (icons only).
          "in-data-[collapsible=dock]:hidden",
        )}
      >
        <span>{label}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-3.5 opacity-55 transition-transform duration-200 ease-out",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {/* Items stay mounted for a11y focus order; hidden when collapsed. */}
      <div
        className={cn(
          "flex flex-col gap-y-0.5 pt-0.5",
          !open && "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}
