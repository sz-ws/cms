"use client";

import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/I18nProvider";
import { PER_PAGE_OPTIONS } from "./params";
import { useCollectionParams } from "./useCollectionParams";

// 分頁列:「X–Y of TOTAL」(TOTAL 走 NumberFlow + tabular-nums)+ prev/next + 頁大小。
// 單頁時仍顯示計數與頁大小,只是 prev/next disabled。空清單由 view 的 EmptyState 接手。

interface CollectionPaginationProps {
  page: number;
  perPage: number;
  total: number;
  count: number; // 本頁實際列數
}

function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 min-w-9 items-center justify-center rounded-[8px] bg-white px-3 text-[13px] font-medium text-black/70 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[box-shadow,transform] active:scale-[0.96]",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:shadow-[0_0_0_1px_rgba(0,0,0,0.18)]",
      )}
    >
      {label}
    </button>
  );
}

export function CollectionPagination({
  page,
  perPage,
  total,
  count,
}: CollectionPaginationProps) {
  const { setParam } = useCollectionParams();
  const t = useT();
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = (page - 1) * perPage + count;
  const lastPage = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* from–to 之間維持緊貼(en dash 不加空格);"of" 前後用實際空白字元(非
          只靠 CSS padding)分隔 —— padding 產生的間距純視覺,text-only 讀取(複製
          貼上、螢幕閱讀器、自動化檢測)會被吃掉變成 "20of",两種 layout(table/
          grid)共用同一顆元件,這裡修一次兩邊都對。 */}
      <p className="text-[12px] tabular-nums text-black/45">
        <span className="tabular-nums">{from}</span>
        <span>–</span>
        <span className="tabular-nums">{to}</span>
        <span className="text-black/30"> of </span>
        <NumberFlow
          value={total}
          className="text-black/70"
          style={{ fontVariantNumeric: "tabular-nums" }}
        />
      </p>

      <div className="flex items-center gap-3">
        <div className="inline-flex items-center gap-2">
          <span className="text-[12px] text-black/40">{t("collection.perPage")}</span>
          <Select
            value={String(perPage)}
            onValueChange={(next) => setParam("perPage", String(next))}
          >
            <SelectTrigger size="sm" className="tabular-nums">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false}>
              {PER_PAGE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)} className="tabular-nums">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <PagerButton
            label={t("collection.prev")}
            disabled={page <= 1}
            onClick={() => setParam("page", String(page - 1), false)}
          />
          <span className="px-1 text-[12px] tabular-nums text-black/40">
            {page} / {lastPage}
          </span>
          <PagerButton
            label={t("collection.next")}
            disabled={page >= lastPage}
            onClick={() => setParam("page", String(page + 1), false)}
          />
        </div>
      </div>
    </div>
  );
}
