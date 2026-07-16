"use client";

import { Input } from "@/components/ui/input";
import type { FieldComponentProps } from "./types";

// text field:styled base atom(shadcn Input,concentric radii/shadow 已在
// Input 自身樣式中)。value/stored shape:plain string。

export function TextField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string>) {
  return (
    <Input
      id={`field-${field.key}`}
      value={value ?? ""}
      disabled={disabled}
      aria-invalid={Boolean(error)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
