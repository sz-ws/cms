"use client";

import { useState } from "react";
import { CalendarClock, X } from "lucide-react";
import { TextMorph } from "torph/react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Admin-only publish scheduling control(FormView status 區塊,僅 Draft 時顯示)。
// value = epoch ms(row 層 publishAt,見 content-provider.ts extractPublishAt)
// 或 null(未排程)。Popover 內是 draft state(date + "HH:MM"),按 Set 才 combine
// 回寫 —— 避免「選了日期還沒選時間」的半套值流出去。
//
// Calendar 擋掉今天以前的日子(排程過去沒有意義);既有 value 若已過期(舊排程
// 未被 sweep 前重開編輯),chip 下方顯示「下次掃描立即發佈」提示而非阻擋。

interface PublishScheduleControlProps {
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

const DEFAULT_TIME = "09:00";

function formatSchedule(v: number): string {
  return new Date(v).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toTimeString(v: number): string {
  const d = new Date(v);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function combine(date: Date, time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    h,
    min,
  ).getTime();
}

export function PublishScheduleControl({
  value,
  onChange,
  disabled,
}: PublishScheduleControlProps) {
  const [open, setOpen] = useState(false);
  // Popover 的 draft state:開啟時從 value 播種(見 onOpenChange)。
  const [draftDate, setDraftDate] = useState<Date | undefined>(undefined);
  const [draftTime, setDraftTime] = useState(DEFAULT_TIME);
  // render 內不可呼叫 Date.now()(react-hooks/purity);mount 時取一次即可 ——
  // 「已過期」提示的用途只是提醒舊排程會被下次掃描撿走,毫秒級精準沒有意義。
  const [mountedAt] = useState(() => Date.now());

  const scheduled = value !== null;
  const past = scheduled && value <= mountedAt;
  const combined = draftDate ? combine(draftDate, draftTime) : null;

  function seedAndToggle(next: boolean) {
    if (next) {
      const base = value !== null ? new Date(value) : undefined;
      setDraftDate(base);
      setDraftTime(value !== null ? toTimeString(value) : DEFAULT_TIME);
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
                  "inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)] disabled:opacity-50",
                  scheduled
                    ? "bg-[rgba(86,114,228,0.10)] text-[rgb(76,102,210)] shadow-[inset_0_0_0_1px_rgba(86,114,228,0.16)]"
                    : "text-black/45 hover:bg-black/[0.04] hover:text-black/70",
                )}
              >
                <CalendarClock className="size-3.5" aria-hidden />
                <TextMorph respectReducedMotion>
                  {scheduled ? formatSchedule(value) : "Schedule…"}
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
            <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] px-3 py-2.5">
              <input
                type="time"
                aria-label="Publish time"
                value={draftTime}
                onChange={(e) => setDraftTime(e.target.value)}
                className="h-8 rounded-[8px] bg-black/[0.04] px-2 text-[13px] tabular-nums text-black/80 outline-none focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)]"
              />
              <button
                type="button"
                onClick={apply}
                disabled={combined === null}
                className="inline-flex h-8 items-center rounded-[8px] bg-black px-3 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black/85 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Set schedule
              </button>
            </div>
          </PopoverContent>
        </Popover>
        {scheduled && (
          <button
            type="button"
            aria-label="Clear schedule"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="inline-flex size-8 items-center justify-center rounded-[8px] text-black/35 transition-colors duration-150 hover:bg-black/[0.04] hover:text-black/70 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {scheduled && (
        <p className="text-[11px] text-black/35">
          {past
            ? "This time has passed — the entry will publish on the next sweep."
            : "Publishes automatically at this time."}
        </p>
      )}
    </div>
  );
}
