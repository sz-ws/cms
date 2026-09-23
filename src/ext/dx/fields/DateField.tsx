"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar, dayPickerLocale } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDateFormatter } from "@/components/DateTimeProvider";
import type { DateFormatter } from "@/lib/datetime";
import { useExtLocale, useExtT } from "../ext-locale";
import type { FieldComponentProps } from "./types";

// date field:Calendar popover picker(react-day-picker,shadcn Calendar) —— 從不
// 用原生 <input type="date">。
//
// 值形狀偏離 dx-field-components.md 的地方(已與文件作者同步,見 types.ts):
// 這個 codebase 的 date 欄位一律以 **epoch 毫秒 number** 儲存
// (content-provider.ts CoreContentProvider.toEpoch),不是文件寫的 ISO date
// string。這裡 value/onChange 都走 epoch-ms number,顯示時才轉 Date。
//
// 1.41.0:「哪一天」以站台時區為準(lib/datetime.ts)。存的是站台時區那天的 00:00;
// 月曆元件用瀏覽器時區,所以進出月曆時用年月日換算,不直接拿 ms 當 Date。

function epochToDate(v: number | undefined, dates: DateFormatter): Date | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const [year, month, day] = dates.dayKey(v).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateToEpoch(d: Date, dates: DateFormatter): number | undefined {
  const pad = (n: number) => String(n).padStart(2, "0");
  return dates.dayStart(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
}

function formatDisplay(v: number | undefined, dates: DateFormatter, placeholder: string): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return placeholder;
  return dates.format(v, { year: "numeric", month: "short", day: "numeric" });
}

export function DateField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<number | undefined>) {
  const [open, setOpen] = useState(false);
  const dates = useDateFormatter();
  const selected = epochToDate(value, dates);
  // 公開表單沒有 I18nProvider,月曆的語系從 field 樹拿(同 label)。
  const locale = useExtLocale();
  const t = useExtT();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={`field-${field.key}`}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-invalid={Boolean(error)}
            className={cn(
              "h-9 min-h-9 w-full justify-start rounded-3xl px-3 font-normal transition-[background-color,color]",
              !selected && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="size-4" />
            {formatDisplay(value, dates, t("dxField.date.pick"))}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={dayPickerLocale(locale)}
          selected={selected}
          onSelect={(date) => {
            onChange(date ? dateToEpoch(date, dates) : undefined);
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
