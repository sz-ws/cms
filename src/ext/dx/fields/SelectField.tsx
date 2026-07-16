"use client";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import type { FieldComponentProps } from "./types";

// select field:searchable combobox(base-ui Combobox,同 shadcn "Combobox"
// 元件家族,底層等同 cmdk 的 popover+search 模式)。永不用原生 <select>。
// stored value:string,必須是 field.options 之一(見 content-provider.ts
// validateField 的 select 分支)。

export function SelectField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string>) {
  const options = field.options ?? [];

  return (
    <Combobox
      items={options}
      value={value || null}
      onValueChange={(next: unknown) =>
        onChange(typeof next === "string" ? next : "")
      }
      disabled={disabled}
    >
      <ComboboxInput
        id={`field-${field.key}`}
        placeholder="Select…"
        aria-invalid={Boolean(error)}
        showClear={Boolean(value)}
      />
      <ComboboxContent>
        <ComboboxEmpty>No matches.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
