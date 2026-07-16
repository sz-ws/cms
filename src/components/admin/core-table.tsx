"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

// Core 表格範式(task #18 第一塊磚)—— /admin/users 立下的視覺語言抽成共用:
// 白底 rounded-[12px] 容器 + hairline ring、uppercase 小表頭、hover 列 tint、
// active 列品牌藍 4.5% 底、trailing actions hover 才浮現、窄視窗容器自己橫向捲
// (body 永不橫向捲)。資料驅動:加一欄 = 加一筆 CoreColumn 定義。
// i18n 在消費端解好(label 收 ReactNode),這層不碰字典。

export interface CoreColumn<T> {
  key: string;
  label: React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  thClass?: string;
  tdClass?: string;
  render: (row: T) => React.ReactNode;
}

export type CoreSort = { key: string; dir: 1 | -1 } | null;

interface CoreTableProps<T> {
  columns: CoreColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 列點擊(通常開詳情 sheet)。給了才有 cursor-pointer / focus 行為。 */
  onRowClick?: (row: T) => void;
  /** 此列目前是否「作用中」(例如它的 sheet 開著)—— 上品牌藍 tint 與 sheet 連動。 */
  rowActive?: (row: T) => boolean;
  /** trailing 動作格(hover / 列 focus 才浮現);內部已 stopPropagation。 */
  trailingActions?: (row: T) => React.ReactNode;
  /** trailing th 的無障礙名稱。 */
  trailingLabel?: string;
  /** 表格最小寬(窄視窗時容器橫向捲的下限),預設 600px。 */
  minWidth?: number;
}

export function CoreTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowActive,
  trailingActions,
  trailingLabel = "Row actions",
  minWidth = 600,
}: CoreTableProps<T>) {
  const [sort, setSort] = useState<CoreSort>(null);

  const sorted = sort
    ? [...rows].sort((a, b) => {
        const col = columns.find((c) => c.key === sort.key);
        if (!col?.sortValue) return 0;
        const av = col.sortValue(a);
        const bv = col.sortValue(b);
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      })
    : rows;

  function toggleSort(key: string) {
    setSort((s) =>
      s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null,
    );
  }

  return (
    <div className="overflow-x-auto rounded-[12px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_1px_3px_-1px_rgba(20,15,40,0.06)]">
      <table
        className="w-full border-separate border-spacing-0 text-left"
        style={{ minWidth }}
      >
        <thead>
          <tr className="bg-black/[0.015]">
            {columns.map((col) => (
              <th
                key={col.key}
                aria-sort={
                  sort?.key === col.key
                    ? sort.dir === 1
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={cn(
                  "border-b border-black/[0.07] px-4 py-2.5 text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-black/35 uppercase select-none",
                  col.thClass,
                )}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className="group/th relative -my-1 flex items-center gap-0.5 py-1 transition-colors hover:text-black/60"
                  >
                    {col.label}
                    <span className="flex w-3 justify-center">
                      {sort?.key === col.key ? (
                        sort.dir === 1 ? (
                          <ChevronUp className="size-3" />
                        ) : (
                          <ChevronDown className="size-3" />
                        )
                      ) : (
                        <ChevronUp className="size-3 opacity-0 transition-opacity group-hover/th:opacity-40" />
                      )}
                    </span>
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
            {trailingActions && (
              <th
                className="w-0 border-b border-black/[0.07]"
                aria-label={trailingLabel}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const active = rowActive?.(row) ?? false;
            return (
              <tr
                key={rowKey(row)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget)
                          onRowClick(row);
                      }
                    : undefined
                }
                data-active={active || undefined}
                // 容器已是白底圓角,列只做安靜的 tint;作用中的列上品牌藍 4.5% 底
                // 跟右側 sheet 連動。末列 td 去底線(容器圓角自己收邊)。
                className={cn(
                  "group/row transition-colors last:[&>td]:border-b-0 focus-visible:outline-none",
                  onRowClick && "cursor-pointer",
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "border-b border-black/[0.05] px-4 py-2.5 transition-colors duration-150",
                      onRowClick &&
                        "group-hover/row:bg-black/[0.02] group-focus-visible/row:bg-black/[0.02]",
                      active && "bg-[rgb(86,114,228)]/[0.045]",
                      col.tdClass,
                    )}
                  >
                    {col.render(row)}
                  </td>
                ))}
                {trailingActions && (
                  <td
                    className={cn(
                      "border-b border-black/[0.05] py-2.5 pr-4 pl-2 text-right whitespace-nowrap transition-colors duration-150",
                      onRowClick &&
                        "group-hover/row:bg-black/[0.02] group-focus-visible/row:bg-black/[0.02]",
                      active && "bg-[rgb(86,114,228)]/[0.045]",
                    )}
                  >
                    <span
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-visible/row:opacity-100 group-hover/row:opacity-100"
                    >
                      {trailingActions(row)}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RowIconButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        // 視覺 32px,relative before 撐滿 40px hit area
        "relative flex size-8 items-center justify-center rounded-[7px] text-black/40 transition-[background-color,color,transform] before:absolute before:-inset-1 active:scale-[0.96]",
        danger
          ? "hover:bg-red-50 hover:text-red-600"
          : "hover:bg-black/[0.05] hover:text-black/75",
      )}
    >
      {children}
    </button>
  );
}
