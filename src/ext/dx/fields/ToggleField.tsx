"use client";

import { Switch } from "@/components/ui/switch";
import type { FieldComponentProps } from "./types";

// toggle field:styled Switch(非 checkbox 視覺)。stored value:boolean。
// label click 聚焦控制項 —— Switch 本身是 button role,htmlFor 已足夠。

export function ToggleField({
  value,
  onChange,
  field,
  disabled,
}: FieldComponentProps<boolean>) {
  return (
    <Switch
      id={`field-${field.key}`}
      checked={Boolean(value)}
      disabled={disabled}
      onCheckedChange={(checked) => onChange(checked)}
      className="active:scale-[0.96] transition-[background-color,border-color]"
    />
  );
}
