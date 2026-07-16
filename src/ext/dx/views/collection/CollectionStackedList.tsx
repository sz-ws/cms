import Link from "next/link";
import { StatusBadge } from "../StatusBadge";
import { StackedList, StackedListItem } from "@/components/ui/stacked-list";
import type { ColumnMeta, RowData } from "./CollectionTable";

// core-v2 §3.5:third sibling of CollectionTable / CollectionGrid — vendored
// StackedList/StackedListItem sweep-in motion (see ExtRecentCard) applied to the
// full row set. Each row keeps the same computed cells as the table layout (first
// cell = title, rest = inline meta) and the same edit link + StatusBadge; only the
// container/motion changes. A lightweight feed view, not the power-table — no
// bulk-select surface here (mirrors ExtRecentCard, which has none either).

interface CollectionStackedListProps {
  columns: ColumnMeta[];
  rows: RowData[];
}

export function CollectionStackedList({ columns, rows }: CollectionStackedListProps) {
  return (
    <div className="overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
      <StackedList className="divide-y divide-black/[0.05]">
        {rows.map((row) => (
          <StackedListItem key={row.id}>
            <Link
              href={row.editHref}
              className="flex items-center gap-4 px-[18px] py-[11px] transition-colors duration-150 ease-out hover:bg-black/[0.02]"
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-black/85">
                {row.cells[0]}
              </span>
              {row.cells.length > 1 && (
                <span className="hidden shrink-0 items-center gap-3 text-[12px] text-black/45 sm:flex">
                  {row.cells.slice(1).map((cell, i) => (
                    <span key={columns[i + 1]?.key ?? i} className="max-w-[140px] truncate">
                      {cell}
                    </span>
                  ))}
                </span>
              )}
              <StatusBadge status={row.status} />
            </Link>
          </StackedListItem>
        ))}
      </StackedList>
    </div>
  );
}
