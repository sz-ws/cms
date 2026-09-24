"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import type { ExtraFieldDef } from "@/lib/extra-fields";
import type { DeclarativeField } from "../manifest";
import { useExtT } from "../ext-locale";
import { NumberField } from "./NumberField";
import { TextareaField } from "./TextareaField";
import { TextField } from "./TextField";
import { ToggleField } from "./ToggleField";

// 編輯頁的「額外欄位」區(定義在設定頁,規則見 lib/extra-fields.ts)。泛用 FormView 與
// 插件自己的編輯版面(例如 blog 的 layout.tsx)共用這一塊,值由呼叫端握著 ——
// 它們各自有自己的 dirty 判斷與送出 payload,這裡只負責畫。
//
// 控制項直接用宣告欄位的元件,只是替它們湊一個假的 field:id 會是 `field-extra-<key>`,
// 宣告欄位的 key 不能有 "-"(manifest FIELD_KEY_RE),兩邊的 id 不會撞。
// 文案走 useExtT():FormView 裡有 ExtLocaleProvider,插件版面退到後台的 I18nProvider。

interface ExtraFieldsPanelProps {
  defs: readonly ExtraFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

function asField(def: ExtraFieldDef): DeclarativeField {
  return {
    key: `extra-${def.key}`,
    type: def.type === "textarea" ? "text" : def.type,
    label: def.label,
  } as DeclarativeField;
}

function ExtraControl({
  def,
  value,
  onChange,
  disabled,
}: {
  def: ExtraFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const field = asField(def);
  switch (def.type) {
    case "boolean":
      return (
        <ToggleField field={field} value={value === true} onChange={onChange} disabled={disabled} />
      );
    case "number":
      return (
        <NumberField
          field={field}
          value={typeof value === "number" ? value : undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "textarea":
      return (
        <TextareaField
          field={field}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          disabled={disabled}
          rows={3}
        />
      );
    case "text":
      return (
        <TextField
          field={field}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          disabled={disabled}
        />
      );
  }
}

export function ExtraFieldsPanel({ defs, values, onChange, disabled }: ExtraFieldsPanelProps) {
  const t = useExtT();
  const headingId = useId();
  if (defs.length === 0) return null;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="col-span-full flex flex-col gap-3 border-t border-black/[0.06] admin:border-ink/[0.06] pt-4"
    >
      <h3 id={headingId} className="text-[13px] font-semibold text-black/70 admin:text-ink/70">
        {t("extraFields.title")}
      </h3>
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        {defs.map((def) => {
          const control = (
            <ExtraControl
              def={def}
              value={values[def.key]}
              onChange={(value) => onChange(def.key, value)}
              disabled={disabled}
            />
          );
          if (def.type === "boolean") {
            // 開關的名稱放右邊、同一行,跟一般表單的勾選項一樣讀。
            return (
              <div key={def.key} className="flex min-w-0 items-center gap-2.5">
                {control}
                <Label htmlFor={`field-extra-${def.key}`}>{def.label}</Label>
              </div>
            );
          }
          return (
            <div
              key={def.key}
              className={`flex min-w-0 flex-col gap-1.5 ${def.type === "textarea" ? "sm:col-span-2" : ""}`}
            >
              <Label htmlFor={`field-extra-${def.key}`}>{def.label}</Label>
              {control}
            </div>
          );
        })}
      </div>
    </div>
  );
}
