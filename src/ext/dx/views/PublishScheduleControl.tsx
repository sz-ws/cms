"use client";

import { useState } from "react";
import { CalendarClock, X } from "lucide-react";
import { TextMorph } from "torph/react";
import { Calendar } from "@/components/ui/calendar";
import { TimeInput } from "@/components/ui/time-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { wallClock, zonedTimeToMs, type DateFormatter } from "@/lib/datetime";
import { useExtT } from "../ext-locale";

// Admin-only publish scheduling control(FormView status 區塊,僅 Draft 時顯示)。
// value = epoch ms(row 層 publishAt,見 content-provider.ts extractPublishAt)
// 或 null(未排程)。Popover 內是 draft state(date + "HH:MM"),按 Set 才 combine
// 回寫 —— 避免「選了日期還沒選時間」的半套值流出去。
//
// Calendar 擋掉今天以前的日子(排程過去沒有意義);既有 value 若已過期(舊排程
// 未被 sweep 前重開編輯),chip 下方顯示「下次掃描立即發佈」提示而非阻擋。
//
// 1.41.0:日期與時間是站台時區的(lib/datetime.ts)——人在國外排「9/20 09:00」,
// 發佈的是店家那邊的 9/20 早上九點。月曆元件用瀏覽器時區,進出時用年月日換算。
//
// 月曆跟著後台語系(ui/calendar);時間用 24 小時制的 <TimeInput>,不用原生
// <input type="time">(它跟著瀏覽器語系,中文後台會冒出「12:00 AM」)。

interface PublishScheduleControlProps {
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

const DEFAULT_TIME = "09:00";

function formatSchedule(v: number, dates: DateFormatter): string {
  return dates.format(v, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function toTimeString(v: number, timeZone: string): string {
  const w = wallClock(v, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** 站台時區那天的日曆日(給瀏覽器時區的月曆元件用)。 */
function toCalendarDate(v: number, timeZone: string): Date {
  const w = wallClock(v, timeZone);
  return new Date(w.year, w.month - 1, w.day);
}

function combine(date: Date, time: string, timeZone: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return zonedTimeToMs(
    { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: h, minute: min },
    timeZone,
  );
}

export function PublishScheduleControl({
  value,
  onChange,
  disabled,
}: PublishScheduleControlProps) {
  const [open, setOpen] = useState(false);
  const dates = useDateFormatter();
  const timeZone = dates.timeZone;
  const t = useExtT();
  // Popover 的 draft state:開啟時從 value 播種(見 onOpenChange)。
  const [draftDate, setDraftDate] = useState<Date | undefined>(undefined);
  const [draftTime, setDraftTime] = useState(DEFAULT_TIME);
  // render 內不可呼叫 Date.now()(react-hooks/purity);mount 時取一次即可 ——
  // 「已過期」提示的用途只是提醒舊排程會被下次掃描撿走,毫秒級精準沒有意義。
  const [mountedAt] = useState(() => Date.now());

  const scheduled = value !== null;
  const past = scheduled && value <= mountedAt;
  const combined = draftDate ? combine(draftDate, draftTime, timeZone) : null;

  function seedAndToggle(next: boolean) {
    if (next) {
      const base = value !== null ? toCalendarDate(value, timeZone) : undefined;
      setDraftDate(base);
      setDraftTime(value !== null ? toTimeString(value, timeZone) : DEFAULT_TIME);
    }
    setOpen(next);
  }

  function apply() {
    if (combined === null) return;
    onChange(combined);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="inline-flex items-center gap-1">
        <Popover open={open} onOpenChange={seedAndToggle}>
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)] disabled:opacity-50",
                  scheduled
                    ? "bg-(--admin-accent)/[0.10] text-[color-mix(in_srgb,var(--admin-accent)_88%,black)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--admin-accent)_16%,transparent)]"
                    : "text-black/45 admin:text-ink/45 hover:bg-black/[0.04] admin:hover:bg-ink/[0.04] hover:text-black/70 admin:hover:text-ink/70",
                )}
              >
                <CalendarClock className="size-3.5" aria-hidden />
                <TextMorph respectReducedMotion>
                  {scheduled ? formatSchedule(value, dates) : t("publishSchedule.trigger")}
                </TextMorph>
              </button>
            }
          />
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={draftDate}
              onSelect={(date) => setDraftDate(date ?? undefined)}
              disabled={{ before: new Date(mountedAt) }}
              autoFocus
            />
            <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] admin:border-ink/[0.06] px-3 py-2.5">
              <TimeInput
                aria-label={t("publishSchedule.time")}
                value={draftTime}
                onChange={setDraftTime}
                className="h-8 rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black/[0.04] admin:bg-ink/[0.04] px-1 text-[13px] text-black/80 admin:text-ink/80 has-[select:focus-visible]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--admin-accent)_35%,transparent)]"
              />
              <button
                type="button"
                onClick={apply}
                disabled={combined === null}
                className="inline-flex h-8 items-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] bg-black admin:bg-ink px-3 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 admin:hover:bg-ink/85 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {t("publishSchedule.set")}
              </button>
            </div>
          </PopoverContent>
        </Popover>
        {scheduled && (
          <button
            type="button"
            aria-label={t("publishSchedule.clear")}
            disabled={disabled}
            onClick={() => onChange(null)}
            className="inline-flex size-8 items-center justify-center rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] text-black/35 admin:text-ink/35 transition-colors duration-150 hover:bg-black/[0.04] admin:hover:bg-ink/[0.04] hover:text-black/70 admin:hover:text-ink/70 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {scheduled && (
        <p className="text-[11px] text-black/35 admin:text-ink/35">
          {past ? t("publishSchedule.past") : t("publishSchedule.upcoming")}
        </p>
      )}
    </div>
  );
}
