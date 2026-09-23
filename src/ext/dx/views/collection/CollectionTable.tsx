"use client";

import { useMemo, useOptimistic, useState, type ReactNode } from "react";
import { AdminLink } from "@/components/admin/AdminLink";
import { cn } from "@/lib/utils";
import { stableReducer } from "@/lib/optimistic";
import { StatusBadge } from "../StatusBadge";
import { SortableHeader } from "./SortableHeader";
import { BulkActionBar } from "./BulkActionBar";
import { applyBulkAction, type BulkAction } from "./optimistic";
import { useT } from "@/lib/i18n/I18nProvider";

// 表格(client):擁有 row selection state,渲染 server 傳入的 cell ReactNode。
// 表頭可排序欄位用 SortableHeader,其餘為靜態標籤。checkbox 欄與列連結不重疊
// (checkbox 有自己的 hit area,列點擊區只在 cell/edit)。

export interface ColumnMeta {
  key: string;
  label: string;
  sortable: boolean;
  align?: "left" | "right";
}

export interface RowData {
  id: string;
  status: string;
  editHref: string;
  cells: ReactNode[]; // 對應 columns 順序
  /** 批次動作樂觀套上、server 還沒確認(見 ./optimistic.ts)。 */
  pending?: boolean;
}

// 批次動作先畫到列上(BulkActionBar 在 transition 裡呼叫);server 資料回來就被取代。
const reduceRows = stableReducer<RowData[], BulkAction>(applyBulkAction);

interface CollectionTableProps {
  extId: string;
  typeName: string;
  columns: ColumnMeta[];
  rows: RowData[];
  activeSort?: { field: string; dir: "asc" | "desc" };
  /** false = 只能檢視這一頁:不畫選取欄與批次動作列。預設 true。 */
  selectable?: boolean;
}

function RingCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-[6px] admin:rounded-[calc(6px*var(--admin-radius-scale,1))] transition-[background,box-shadow] active:scale-[0.9]",
        checked
          ? "bg-(--admin-accent) shadow-[0_0_0_1px_var(--admin-accent)]"
          : "bg-white admin:bg-surface shadow-[0_0_0_1px_rgba(0,0,0,0.15)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.3)]",
      )}
    >
      {checked && (
        <svg viewBox="0 0 12 12" className="size-3 text-(--admin-accent-fg)" aria-hidden>
          <path
            d="M2.5 6.2l2 2 5-5.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

export function CollectionTable({
  extId,
  typeName,
  columns,
  rows,
  activeSort,
  selectable = true,
}: CollectionTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shownRows, applyOptimistic] = useOptimistic<RowData[], BulkAction>(
    rows,
    reduceRows,
  );
  const t = useT();

  const allIds = useMemo(() => shownRows.map((r) => r.id), [shownRows]);
  const allSelected = selected.size > 0 && selected.size === shownRows.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === shownRows.length ? new Set() : new Set(allIds),
    );
  }

  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-white admin:bg-surface shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-black/[0.06] admin:border-ink/[0.06]">
              {selectable && (
                <th className="w-10 px-3 py-2.5">
                  <RingCheckbox
                    checked={allSelected}
                    onChange={toggleAll}
                    label={t("collection.selectAllRows")}
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-2.5",
                    col.align === "right" && "text-right",
                  )}
                >
                  {col.sortable ? (
                    <SortableHeader
                      label={col.label}
                      field={col.key}
                      activeField={activeSort?.field}
                      activeDir={activeSort?.dir}
                      align={col.align}
                    />
                  ) : (
                    <span className="text-[12px] font-medium text-black/45 admin:text-ink/45">
                      {col.label}
                    </span>
                  )}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right">
                <span className="text-[12px] font-medium text-black/45 admin:text-ink/45">
                  Status
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.05] admin:divide-ink/[0.05]">
            {shownRows.map((row) => {
              const isSel = selected.has(row.id);
              return (
                <tr
                  key={row.id}
                  aria-busy={row.pending || undefined}
                  className={cn(
                    "transition-[background-color,opacity]",
                    isSel ? "bg-(--admin-accent)/[0.04]" : "hover:bg-black/[0.02] admin:hover:bg-ink/[0.02]",
                    row.pending && "opacity-60",
                  )}
                >
                  {selectable && (
                    <td className="px-3 py-2.5 align-middle">
                      <RingCheckbox
                        checked={isSel}
                        onChange={() => toggle(row.id)}
                        label={`Select row ${row.id}`}
                      />
                    </td>
                  )}
                  {row.cells.map((cell, i) => (
                    <td
                      key={columns[i]?.key ?? i}
                      className={cn(
                        "px-4 py-2.5 align-middle",
                        columns[i]?.align === "right" && "text-right",
                      )}
                    >
                      {i === 0 ? (
                        <AdminLink
                          href={row.editHref}
                          className="inline-block rounded-[4px] admin:rounded-[calc(4px*var(--admin-radius-scale,1))] outline-none transition-colors hover:text-(--admin-accent) focus-visible:text-(--admin-accent)"
                        >
                          {cell}
                        </AdminLink>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right align-middle">
                    <StatusBadge status={row.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectable && (
        <BulkActionBar
          extId={extId}
          typeName={typeName}
          ids={[...selected]}
          onDone={clearSelection}
          onOptimistic={applyOptimistic}
        />
      )}
    </div>
  );
}
