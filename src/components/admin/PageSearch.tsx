"use client";

import { useMemo, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  dayInputToMs,
  msToDayInput,
  OPEN_PARAM,
  parseRecordSearch,
  recordSearchParams,
  type RecordSearch,
} from "@/ext/record-search";
import { useDateFormatter } from "@/components/DateTimeProvider";
import type { DateFormatter } from "@/lib/datetime";

// 1.40.0:插件後台頁的搜尋框,畫在頂欄麵包屑右邊。
//
// 插件只在 adminPages[].search 宣告欄位(ext/record-search.ts),這裡負責畫與寫網址:
// ?q=&from=&to=,其他參數(狀態篩選等)原樣保留;換條件時拿掉 open(不重開明細)
// 與 page(回第一頁)。頁面讀條件用 parseRecordSearch(server)或 useRecordSearch()。

const RESET_ON_SEARCH = ["q", "from", "to", OPEN_PARAM, "page"];

/** client 頁面讀目前的搜尋條件(與頂欄搜尋框同一份網址)。 */
export function useRecordSearch(): RecordSearch {
  const params = useSearchParams();
  const key = recordSearchParams(parseRecordSearch(params)).toString();
  return useMemo(() => parseRecordSearch(new URLSearchParams(key)), [key]);
}

export interface PageSearchConfig {
  placeholder: string;
  /** 宣告了日期欄位:多一個「期間」。 */
  dates: boolean;
}

export function PageSearch(props: PageSearchConfig) {
  const params = useSearchParams();
  const pathname = usePathname();
  const search = parseRecordSearch(params);
  // 網址上的條件變了(⌘K 帶 q 進來、換頁)就重來,輸入框顯示網址上的值。
  const key = `${pathname}?${recordSearchParams(search)}`;
  return <PageSearchForm key={key} {...props} search={search} />;
}

const DATE_FIELD =
  "h-8 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-2.5 text-[13px] text-ink/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] " +
  "focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]";

function rangeLabel(search: RecordSearch, formatter: DateFormatter): string | null {
  if (search.from === undefined && search.to === undefined) return null;
  const short = (ms: number) => formatter.monthDay(ms);
  const from = search.from !== undefined ? short(search.from) : "";
  const to = search.to !== undefined ? short(search.to - 1) : "";
  return `${from}–${to}`;
}

function PageSearchForm({
  placeholder,
  dates,
  search,
}: PageSearchConfig & { search: RecordSearch }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const formatter = useDateFormatter();
  const timeZone = formatter.timeZone;
  const [q, setQ] = useState(search.q ?? "");
  const [from, setFrom] = useState(msToDayInput(search.from, false, timeZone));
  const [to, setTo] = useState(msToDayInput(search.to, true, timeZone));
  const [rangeOpen, setRangeOpen] = useState(false);
  const range = rangeLabel(search, formatter);

  function go(next: RecordSearch) {
    const kept = new URLSearchParams(params);
    for (const name of RESET_ON_SEARCH) kept.delete(name);
    for (const [name, value] of recordSearchParams(next)) kept.set(name, value);
    const query = kept.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const current = (): RecordSearch => ({
    q: q.trim() || undefined,
    from: dayInputToMs(from, false, timeZone),
    to: dayInputToMs(to, true, timeZone),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    go(current());
  }

  return (
    <form role="search" onSubmit={onSubmit} className="flex items-center gap-1.5">
      <label className="relative flex items-center">
        <span className="sr-only">搜尋</span>
        <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-ink/35" />
        <input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          // Enter 直接送出,不靠表單的隱式送出(沒有送出鈕時各瀏覽器行為不一);
          // 注音/拼音選字中的 Enter 是確認選字,不送。
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            go(current());
          }}
          placeholder={placeholder}
          maxLength={100}
          className={cn(
            "h-8 w-44 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface pr-7 pl-8 text-[13px] text-ink/80 sm:w-64",
            "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] placeholder:text-ink/35",
            "transition-shadow duration-150 focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3)]",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {q ? (
          <button
            type="button"
            aria-label="清除搜尋"
            onClick={() => {
              setQ("");
              go({ ...current(), q: undefined });
            }}
            className="absolute right-1.5 flex size-5 items-center justify-center rounded-[calc(5px*var(--admin-radius-scale,1))] text-ink/35 hover:bg-ink/[0.05] hover:text-ink/70"
          >
            <X aria-hidden className="size-3" />
          </button>
        ) : null}
      </label>
      {dates ? (
        <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
          {/* type="button":沒標的話它是表單裡第一個 submit 鈕,在搜尋框按 Enter
              會變成打開期間,而不是送出搜尋。 */}
          <PopoverTrigger
            type="button"
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] font-medium",
              "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-colors duration-150 hover:bg-ink/[0.03]",
              range ? "text-ink/80" : "text-ink/50",
            )}
          >
            <CalendarDays aria-hidden className="size-3.5" />
            {range ?? "期間"}
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-auto flex-col gap-3 p-3">
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="從"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className={DATE_FIELD}
              />
              <span aria-hidden className="text-[12px] text-ink/35">
                到
              </span>
              <input
                type="date"
                aria-label="到"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className={DATE_FIELD}
              />
            </div>
            <div className="flex justify-end gap-2">
              {range ? (
                <button
                  type="button"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                    setRangeOpen(false);
                    go({ q: current().q });
                  }}
                  className="h-8 px-2 text-[12.5px] text-ink/50 hover:text-ink/80"
                >
                  清除期間
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setRangeOpen(false);
                  go(current());
                }}
                className="h-8 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink/85"
              >
                套用
              </button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </form>
  );
}
