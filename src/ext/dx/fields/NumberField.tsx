"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FieldComponentProps } from "./types";

// number field:stepper input,honour min/max/step from field def when present.
// manifest v1 schema 目前沒有 min/max/step —— 這裡用 `as` 讀取可選屬性,manifest
// 擴充後(Tier 2 number-unit)自然生效,不需要改這個元件。

interface NumberFieldDef {
  min?: number;
  max?: number;
  step?: number;
}

function clamp(n: number, min?: number, max?: number): number {
  let out = n;
  if (typeof min === "number") out = Math.max(min, out);
  if (typeof max === "number") out = Math.min(max, out);
  return out;
}

export function NumberField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<number | undefined>) {
  const inputId = useId();
  const def = field as unknown as NumberFieldDef;
  const step = def.step ?? 1;

  function step_(dir: 1 | -1) {
    const current = typeof value === "number" && Number.isFinite(value) ? value : 0;
    onChange(clamp(current + dir * step, def.min, def.max));
  }

  return (
    <div className="flex items-stretch gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={disabled}
        aria-label="Decrease"
        className="h-9 w-9 shrink-0 rounded-3xl transition-[background-color,color] active:scale-[0.96]"
        onClick={() => step_(-1)}
      >
        −
      </Button>
      <Input
        id={`field-${field.key}`}
        type="number"
        inputMode="decimal"
        className={cn("text-center tabular-nums")}
        value={value === undefined || value === null ? "" : String(value)}
        min={def.min}
        max={def.max}
        step={step}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(e) => {
          const s = e.target.value;
          if (s === "") {
            onChange(undefined);
            return;
          }
          const n = Number(s);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={disabled}
        aria-label="Increase"
        className="h-9 w-9 shrink-0 rounded-3xl transition-[background-color,color] active:scale-[0.96]"
        onClick={() => step_(1)}
      >
        +
      </Button>
    </div>
  );
}
