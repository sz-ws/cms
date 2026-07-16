"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT, useLocale } from "@/lib/i18n/I18nProvider";
import type { StatusFilter } from "./params";
import { useCollectionParams } from "./useCollectionParams";

// filter bar:status 分段控制(always)+ 每個 select 欄位一個下拉 + 主 text 欄位的
// contains 搜尋框。全部寫入 searchParams。Paper & Ink:白 surface + shadow-ring,
// 8px 控制圓角,active = dither blue,40px hit area,無 all-caps。

interface SelectFilterDef {
  key: string;
  label: string;
  options: string[];
  value: string; // "" = all
}

interface CollectionToolbarProps {
  status: StatusFilter;
  selects: SelectFilterDef[];
  searchField?: { key: string; label: string };
  search: string;
}

function StatusSegments({ status }: { status: StatusFilter }) {
  const { setParam } = useCollectionParams();
  const t = useT();
  const statusTabs: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("collection.filter.all") },
    { value: "published", label: t("collection.filter.published") },
    { value: "draft", label: t("collection.filter.draft") },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[10px] bg-black/[0.03] p-0.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]">
      {statusTabs.map((tab) => {
        const active = status === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() =>
              setParam("status", tab.value === "all" ? null : tab.value)
            }
            className={cn(
              "inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-medium transition-[background,color,box-shadow] duration-150 active:scale-[0.96]",
              active
                ? "bg-white text-black/90 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)]"
                : "text-black/45 hover:text-black/70",
            )}
            aria-pressed={active}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// base-ui Select 的 value 不吃空字串當「未選」語意(那是 placeholder 的責任),
// 用 sentinel "__any__" 代表「Any」,對外 API(searchParams)仍是 "" / null。
const ANY_VALUE = "__any__";

function SelectFilter({ def }: { def: SelectFilterDef }) {
  const { setParam } = useCollectionParams();
  const t = useT();
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[12px] text-black/45">{def.label}</span>
      <Select
        value={def.value || ANY_VALUE}
        onValueChange={(next) =>
          setParam(`f_${def.key}`, next === ANY_VALUE ? null : String(next))
        }
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectItem value={ANY_VALUE}>{t("collection.filter.any")}</SelectItem>
          {def.options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SearchBox({
  field,
  initial,
}: {
  field: { key: string; label: string };
  initial: string;
}) {
  const { setParam } = useCollectionParams();
  const t = useT();
  const locale = useLocale();
  const [value, setValue] = useState(initial);
  // 外部(back/forward、清除 filter)驅動的 initial 變動 → render 期同步,用
  // 「儲存前值」的官方模式(state,非 ref/effect),避免 cascading render。
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setValue(initial);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onChange(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setParam("q", next.trim() || null);
    }, 300);
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("collection.searchPlaceholder", {
          field: locale === "en" ? field.label.toLowerCase() : field.label,
        })}
        className="h-9 w-56 rounded-[8px] bg-white px-3 text-[13px] text-black/85 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] outline-none transition-[box-shadow] placeholder:text-black/25 focus:shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_0_0_3px_rgba(0,0,0,0.05)]"
      />
    </div>
  );
}

export function CollectionToolbar({
  status,
  selects,
  searchField,
  search,
}: CollectionToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusSegments status={status} />
      {searchField && <SearchBox field={searchField} initial={search} />}
      {selects.map((def) => (
        <SelectFilter key={def.key} def={def} />
      ))}
    </div>
  );
}
