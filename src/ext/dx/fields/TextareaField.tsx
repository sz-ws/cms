"use client";

import { Textarea } from "@/components/ui/textarea";
import type { FieldComponentProps } from "./types";

// textarea field:styled base atom(shadcn Textarea)。目前也是 richtext 的 v1
// fallback(見 RichtextField.tsx 的 TODO)。

export function TextareaField({
  value,
  onChange,
  field,
  error,
  disabled,
  rows = 6,
}: FieldComponentProps<string> & { rows?: number }) {
  return (
    <Textarea
      id={`field-${field.key}`}
      value={value ?? ""}
      rows={rows}
      disabled={disabled}
      aria-invalid={Boolean(error)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
