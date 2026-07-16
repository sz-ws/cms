"use client";

import { cn } from "@/lib/utils";
import { useCollectionParams } from "./useCollectionParams";

// 可排序表頭:點擊循環 none → asc → desc → none。active 以 dither-blue caret 標示。
// none 態顯示極淡的中性 caret 作為 affordance(hover 才明顯)。

interface SortableHeaderProps {
  label: string;
  field: string;
  activeField?: string;
  activeDir?: "asc" | "desc";
  align?: "left" | "right";
}

export function SortableHeader({
  label,
  field,
  activeField,
  activeDir,
  align = "left",
}: SortableHeaderProps) {
  const { commit } = useCollectionParams();
  const active = activeField === field;

  function cycle() {
    commit((p) => {
      if (!active) {
        p.set("sort", field);
        p.set("dir", "asc");
      } else if (activeDir === "asc") {
        p.set("sort", field);
        p.set("dir", "desc");
      } else {
        p.delete("sort");
        p.delete("dir");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className={cn(
        "group inline-flex h-8 items-center gap-1 text-[12px] font-medium text-black/45 transition-colors hover:text-black/70",
        align === "right" && "flex-row-reverse",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "text-[10px] leading-none transition-opacity",
          active
            ? "text-[rgb(86,114,228)] opacity-100"
            : "text-black/30 opacity-0 group-hover:opacity-100",
        )}
        aria-hidden
      >
        {active ? (activeDir === "asc" ? "▲" : "▼") : "▲"}
      </span>
    </button>
  );
}
