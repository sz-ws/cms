"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FieldComponentProps } from "./types";

// date field:Calendar popover picker(react-day-picker,shadcn Calendar) —— 從不
// 用原生 <input type="date">。
//
// 值形狀偏離 dx-field-components.md 的地方(已與文件作者同步,見 types.ts):
// 這個 codebase 的 date 欄位一律以 **epoch 毫秒 number** 儲存
// (content-provider.ts CoreContentProvider.toEpoch),不是文件寫的 ISO date
// string。這裡 value/onChange 都走 epoch-ms number,顯示時才轉 Date。

function epochToDate(v: number | undefined): Date | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return new Date(v);
}

function formatDisplay(v: number | undefined): string {
  const d = epochToDate(v);
  if (!d) return "Pick a date";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DateField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<number | undefined>) {
  const [open, setOpen] = useState(false);
  const selected = epochToDate(value);

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
            {formatDisplay(value)}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            onChange(date ? date.getTime() : undefined);
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
