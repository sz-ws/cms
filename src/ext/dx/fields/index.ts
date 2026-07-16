import type { ComponentType } from "react";
import type { DeclarativeField } from "../manifest";
import { TextField } from "./TextField";
import { TextareaField } from "./TextareaField";
import { TextFullscreenEditor } from "./TextFullscreenEditor";
import { ToggleField } from "./ToggleField";
import { NumberField } from "./NumberField";
import { DateField } from "./DateField";
import { SelectField } from "./SelectField";
import { MediaField } from "./MediaField";
import { RichtextField } from "./RichtextField";
import { SlugField } from "./SlugField";
import { JsonField } from "./JsonField";
import { RelationField } from "./RelationField";
import { RelationsField } from "./RelationsField";
import { GroupField } from "./GroupField";
import { RepeaterField } from "./RepeaterField";
import { BlocksField } from "./BlocksField";

// dx-field-components.md: "registered in a FIELD_COMPONENTS map keyed by
// field type — the FormView only consumes the map." No per-type switch may
// live in FormView anymore; add a new field type by adding a component file
// + one entry here.
//
// Manifest (manifest.ts FIELD_TYPES) declares the types keyed below. `relation`
// and `relations` (08 §1, CORE_API 1.2.0) ARE registered here — a manifest
// using them renders via RelationField / RelationsField, not a text fallback.
// Tier 2 structural fields (group / repeater / blocks, CORE_API 1.3.0) ARE
// registered here too — they recurse into this same map to render their leaf
// subfields (one level of nesting; see LeafFieldControl + manifest.ts).
// Other Tier 1 doc types not yet in the zod schema (datetime, daterange,
// multiselect, tags, image, markdown, color) remain intentionally absent —
// each is a future CORE_API minor bump per the doc's rules.

// Type-erased shape for the map: FormView holds each field's value as
// `unknown` in its FieldValues record (see views/FormView.tsx), so the map
// itself is intentionally loosely typed here — each concrete component still
// gets its own precise `FieldComponentProps<T>` at its definition site.
export interface ErasedFieldComponentProps {
  value: unknown;
  onChange: (next: unknown) => void;
  field: DeclarativeField;
  error?: string;
  disabled?: boolean;
}

/**
 * 按 field 選對應 component。預設 text → TextField;若 manifest 標 multiline:true
 * → TextFullscreenEditor(可放大寫作的 textarea)。
 *
 * 注意這是 runtime 函式,不是靜態 map —— 因為 component 選擇依賴 field 屬性
 * (multiline),不能在 module top-level 寫死。FormView 透過 getFieldComponent(f)
 * 拿到正確元件並 mount,組裝位置仍在 FIELD_COMPONENTS map 的語意內。
 */
export function getFieldComponent(
  field: DeclarativeField,
): ComponentType<ErasedFieldComponentProps> {
  if (field.type === "text" && field.multiline === true) {
    return TextFullscreenEditor as unknown as ComponentType<ErasedFieldComponentProps>;
  }
  const c = FIELD_COMPONENTS[field.type];
  return (c ?? TextField) as ComponentType<ErasedFieldComponentProps>;
}

export const FIELD_COMPONENTS: Record<
  string,
  ComponentType<ErasedFieldComponentProps>
> = {
  text: TextField,
  richtext: RichtextField,
  number: NumberField,
  boolean: ToggleField,
  date: DateField,
  media: MediaField,
  select: SelectField,
  slug: SlugField,
  json: JsonField,
  relation: RelationField,
  relations: RelationsField,
  group: GroupField,
  repeater: RepeaterField,
  blocks: BlocksField,
} as unknown as Record<string, ComponentType<ErasedFieldComponentProps>>;

export { TextareaField };
export type { FieldComponentProps, SlugFieldProps } from "./types";
