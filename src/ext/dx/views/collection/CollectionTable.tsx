"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { StatusBadge } from "../StatusBadge";
import { SortableHeader } from "./SortableHeader";
import { BulkActionBar } from "./BulkActionBar";
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
}

interface CollectionTableProps {
  extId: string;
  typeName: string;
  columns: ColumnMeta[];
  rows: RowData[];
  activeSort?: { field: string; dir: "asc" | "desc" };
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
        "inline-flex size-5 items-center justify-center rounded-[6px] transition-[background,box-shadow] active:scale-[0.9]",
        checked
          ? "bg-[rgb(86,114,228)] shadow-[0_0_0_1px_rgb(86,114,228)]"
          : "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)] hover:shadow-[0_0_0_1px_rgba(0,0,0,0.3)]",
      )}
    >
      {checked && (
        <svg viewBox="0 0 12 12" className="size-3 text-white" aria-hidden>
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
}: CollectionTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const t = useT();

  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = selected.size > 0 && selected.size === rows.length;

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
      prev.size === rows.length ? new Set() : new Set(allIds),
    );
  }

  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-black/[0.06]">
              <th className="w-10 px-3 py-2.5">
                <RingCheckbox
                  checked={allSelected}
                  onChange={toggleAll}
                  label={t("collection.selectAllRows")}
                />
              </th>
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
                    <span className="text-[12px] font-medium text-black/45">
                      {col.label}
                    </span>
                  )}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right">
                <span className="text-[12px] font-medium text-black/45">
                  Status
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.05]">
            {rows.map((row) => {
              const isSel = selected.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={cn(
                    "transition-colors",
                    isSel ? "bg-[rgb(86,114,228)]/[0.04]" : "hover:bg-black/[0.02]",
                  )}
                >
                  <td className="px-3 py-2.5 align-middle">
                    <RingCheckbox
                      checked={isSel}
                      onChange={() => toggle(row.id)}
                      label={`Select row ${row.id}`}
                    />
                  </td>
                  {row.cells.map((cell, i) => (
                    <td
                      key={columns[i]?.key ?? i}
                      className={cn(
                        "px-4 py-2.5 align-middle",
                        columns[i]?.align === "right" && "text-right",
                      )}
                    >
                      {i === 0 ? (
                        <Link
                          href={row.editHref}
                          className="inline-block rounded-[4px] outline-none transition-colors hover:text-[rgb(86,114,228)] focus-visible:text-[rgb(86,114,228)]"
                        >
                          {cell}
                        </Link>
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

      <BulkActionBar
        extId={extId}
        typeName={typeName}
        ids={[...selected]}
        onDone={clearSelection}
      />
    </div>
  );
}
