"use client";

import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { CalendarDays, Download, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusMultiFilter } from "@/components/admin/StatusMultiFilter";
import { isImeKeyEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";
import type { DateFormatter } from "@/lib/datetime";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/I18nProvider";
import type { RoleOption, UserRecord } from "./UsersTable";
import {
  choiceOf,
  filterUsers,
  hasDayRange,
  hasUsersNarrowing,
  normalizeUsersQuery,
  staffRoleChoices,
  usersFilterParams,
  type DayRange,
  type RoleChoice,
  type UsersFilter,
} from "./users-filter";

// 1.59.0:成員頁的搜尋與篩選列、匯出 CSV、沒有符合時的空狀態。
// 外觀沿用後台其他列表(頂欄的 PageSearch、collection 篩選列的 StatusMultiFilter):
// 8px 圓角的欄位、inset hairline、focus 時 hairline 加深。條件的真相在 UsersTable。

const FIELD_RING =
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-[box-shadow,background-color,color] duration-150";
const FOCUS_RING = "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3),0_0_0_3px_rgba(0,0,0,0.05)]";
const DATE_FIELD = cn(
  "h-8 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface px-2.5 text-[13px] text-ink/80 tabular-nums",
  FIELD_RING,
  "focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]",
);
// date input 的上下限與網址收的範圍一致(users-filter.ts 的 parseDay)。
const MIN_DAY = "2000-01-01";
const MAX_DAY = "2199-12-31";

type T = ReturnType<typeof useT>;

// ---- 搜尋 ----

/**
 * 輸入就篩(資料都在手上)。注音/拼音組字中不篩 —— 否則每打一個注音符號就閃一次
 * 「找不到」;選好字(compositionend)才算數。
 */
function SearchField({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  // 外面清掉搜尋(沒有符合時的「清除」按鈕)時,輸入框跟著變:render 期同步,不用 effect。
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }

  function apply(next: string) {
    setSynced(next);
    onChange(next);
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setDraft(next);
    if (!(event.nativeEvent as InputEvent).isComposing) apply(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || isImeKeyEvent(event) || draft === "") return;
    event.preventDefault();
    setDraft("");
    apply("");
  }

  return (
    <label className="relative flex items-center">
      <span className="sr-only">{t("usersTable.searchPlaceholder")}</span>
      <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-ink/35" />
      <input
        type="search"
        value={draft}
        onChange={onInput}
        onCompositionEnd={(event) => apply(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={t("usersTable.searchPlaceholder")}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-8 w-full rounded-[calc(8px*var(--admin-radius-scale,1))] bg-surface pr-7 pl-8 text-[13px] text-ink/80 sm:w-64",
          FIELD_RING,
          "placeholder:text-ink/35 hover:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.16)]",
          "focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3),0_0_0_3px_rgba(0,0,0,0.05)]",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      {draft ? (
        <button
          type="button"
          aria-label={t("usersTable.clearSearch")}
          onClick={() => {
            setDraft("");
            apply("");
          }}
          className="absolute right-1.5 flex size-5 items-center justify-center rounded-[calc(5px*var(--admin-radius-scale,1))] text-ink/35 transition-colors hover:bg-ink/[0.05] hover:text-ink/70 focus-visible:bg-ink/[0.06] focus-visible:text-ink/70 focus-visible:outline-none"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </label>
  );
}

// ---- 日期區間 ----

/** 觸發鈕上的區間文字:今年的日子只寫月/日,其他年份寫全。 */
function rangeText(range: DayRange, dates: DateFormatter, thisYear: string, t: T): string | null {
  const day = (value: string) => {
    const ms = dates.dayStart(value);
    if (ms === undefined) return value;
    return value.startsWith(thisYear) ? dates.monthDay(ms) : dates.date(ms);
  };
  if (range.from && range.to) return t("usersTable.rangeBoth", { from: day(range.from), to: day(range.to) });
  if (range.from) return t("usersTable.rangeFrom", { from: day(range.from) });
  if (range.to) return t("usersTable.rangeUntil", { to: day(range.to) });
  return null;
}

function DayRangeFilter({
  label,
  range,
  onChange,
  dates,
  thisYear,
}: {
  label: string;
  range: DayRange;
  onChange: (range: DayRange) => void;
  dates: DateFormatter;
  thisYear: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = rangeText(range, dates, thisYear, t);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 text-[12.5px] font-medium whitespace-nowrap",
          FIELD_RING,
          FOCUS_RING,
          "hover:bg-ink/[0.03] active:scale-[0.98]",
          text ? "bg-ink/[0.025] text-ink/80" : "text-ink/50 hover:text-ink/70",
        )}
      >
        <CalendarDays aria-hidden className="size-3.5" />
        {label}
        {text ? <span className="font-normal text-ink/55 tabular-nums">{text}</span> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto flex-col gap-3 p-3">
        <p className="text-[12px] font-medium text-ink/50">{label}</p>
        {/* 改了就套用(資料都在手上),不必另外按「套用」。 */}
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label={t("usersTable.rangeStart")}
            value={range.from ?? ""}
            min={MIN_DAY}
            max={range.to ?? MAX_DAY}
            onChange={(event) => onChange({ ...range, from: event.target.value || null })}
            className={DATE_FIELD}
          />
          <span aria-hidden className="text-[12px] text-ink/35">
            {t("usersTable.rangeSeparator")}
          </span>
          <input
            type="date"
            aria-label={t("usersTable.rangeEnd")}
            value={range.to ?? ""}
            min={range.from ?? MIN_DAY}
            max={MAX_DAY}
            onChange={(event) => onChange({ ...range, to: event.target.value || null })}
            className={DATE_FIELD}
          />
        </div>
        {hasDayRange(range) ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                onChange({ from: null, to: null });
                setOpen(false);
              }}
              className="h-7 rounded-[calc(6px*var(--admin-radius-scale,1))] px-2 text-[12.5px] text-ink/50 transition-colors hover:bg-ink/[0.04] hover:text-ink/80 focus-visible:bg-ink/[0.05] focus-visible:outline-none"
            >
              {t("usersTable.clearRange")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ---- 角色(只有後台人員) ----

const PRESET_LABEL: Record<"admin" | "editor", MessageKey> = {
  admin: "usersTable.roleAdmin",
  editor: "usersTable.roleEditor",
};

function RoleFilter({
  users,
  filter,
  roles,
  timeZone,
  onChange,
}: {
  users: readonly UserRecord[];
  filter: UsersFilter;
  roles: readonly RoleOption[];
  timeZone: string;
  onChange: (roles: RoleChoice[]) => void;
}) {
  const t = useT();
  // 數量照目前的搜尋與日期算(角色本身不算),勾之前就知道會剩幾位。
  const pool = filterUsers(users, { ...filter, roles: [] }, timeZone);
  const counts = new Map<RoleChoice, number>();
  for (const user of pool) counts.set(choiceOf(user), (counts.get(choiceOf(user)) ?? 0) + 1);
  const names = new Map(roles.map((role) => [`role:${role.id}`, role.name]));
  const options = staffRoleChoices(roles.map((role) => role.id)).map((value) => ({
    value,
    label: value === "admin" || value === "editor" ? t(PRESET_LABEL[value]) : (names.get(value) ?? value),
    count: counts.get(value) ?? 0,
  }));
  return (
    <StatusMultiFilter
      label={t("usersTable.role")}
      allLabel={t("usersTable.allRoles")}
      allCount={pool.length}
      options={options}
      selected={filter.roles}
      onChange={(next) => onChange(next as RoleChoice[])}
    />
  );
}

// ---- 整列 ----

export function UsersFilterBar({
  users,
  filter,
  roles,
  dates,
  now,
  onChange,
}: {
  /** 完整列表(角色數量要從這裡算)。 */
  users: readonly UserRecord[];
  filter: UsersFilter;
  roles: readonly RoleOption[];
  dates: DateFormatter;
  now: number;
  onChange: (filter: UsersFilter) => void;
}) {
  const t = useT();
  const thisYear = dates.dayKey(now).slice(0, 4);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-auto">
        <SearchField value={filter.q} onChange={(q) => onChange({ ...filter, q })} />
      </div>
      <DayRangeFilter
        label={t("usersTable.filterJoined")}
        range={filter.joined}
        onChange={(joined) => onChange({ ...filter, joined })}
        dates={dates}
        thisYear={thisYear}
      />
      <DayRangeFilter
        label={t("usersTable.lastActive")}
        range={filter.active}
        onChange={(active) => onChange({ ...filter, active })}
        dates={dates}
        thisYear={thisYear}
      />
      {filter.view === "staff" ? (
        <RoleFilter
          users={users}
          filter={filter}
          roles={roles}
          timeZone={dates.timeZone}
          onChange={(next) => onChange({ ...filter, roles: next })}
        />
      ) : null}
    </div>
  );
}

// ---- 匯出 ----

/** 匯出畫面上這組條件的所有人(伺服器照同一份條件再篩一次,不分頁)。 */
export function ExportCsvLink({ filter, disabled }: { filter: UsersFilter; disabled: boolean }) {
  const t = useT();
  const className = cn(
    "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150",
    "focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none",
  );
  const icon = <Download aria-hidden className="size-3.5" />;
  if (disabled) {
    return (
      <span aria-disabled="true" className={cn(className, "cursor-not-allowed text-ink/25")}>
        {icon}
        {t("usersTable.exportCsv")}
      </span>
    );
  }
  const query = usersFilterParams(filter).toString();
  return (
    <a
      href={`/api/users/export${query ? `?${query}` : ""}`}
      className={cn(className, "text-ink/50 hover:bg-ink/[0.05] hover:text-ink/80 active:scale-[0.96]")}
    >
      {icon}
      {t("usersTable.exportCsv")}
    </a>
  );
}

// ---- 沒有符合 ----

export function NoMatch({ filter, onClear }: { filter: UsersFilter; onClear: (clearAll: boolean) => void }) {
  const t = useT();
  const q = normalizeUsersQuery(filter.q);
  const narrowed = hasUsersNarrowing(filter);
  const clearKey: MessageKey = q && narrowed ? "usersTable.clearAll" : narrowed ? "usersTable.clearFilters" : "usersTable.clearSearch";
  return (
    <div className="flex flex-col items-center gap-3 rounded-[calc(12px*var(--admin-radius-scale,1))] bg-white px-4 py-10 text-center shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
      <p className="text-[13px] text-ink/45">
        {q ? t("usersTable.noMatchQuery", { q }) : t("usersTable.noMatchFilters")}
      </p>
      <button
        type="button"
        onClick={() => onClear(narrowed)}
        className="inline-flex h-8 items-center rounded-full bg-ink/[0.05] px-3.5 text-[12.5px] font-medium text-ink/65 transition-[background-color,color,transform] duration-150 hover:bg-ink/[0.09] hover:text-ink/85 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none active:scale-[0.96]"
      >
        {t(clearKey)}
      </button>
    </div>
  );
}
