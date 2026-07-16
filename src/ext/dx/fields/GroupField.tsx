"use client";

import type { DeclarativeLeafField } from "../manifest";
import type { FieldComponentProps } from "./types";
import { LeafFieldControl } from "./LeafFieldControl";

// Tier 2 v1.2: group field — a nested fieldset. Stored value:
// { …subfield values }. Renders each leaf subfield inline inside an inset card
// (Paper & Ink: light inset surface, shadow-ring, concentric radii). One level
// of nesting only (v1 bound): subfields are leaf types, never another
// group/repeater/blocks — enforced by manifest.ts leafFieldsSchema.
//
// Value contract: the `value` here is the EDITOR-shaped subfield-values object
// (FormView seeds it via field-values.toFieldValue → toLeafValues; submit
// converts back via buildFieldValue → buildLeafValues). Each subfield edit
// produces a fresh object (immutable) and calls onChange with it.

export function GroupField({
  value,
  onChange,
  field,
  disabled,
}: FieldComponentProps<Record<string, unknown>>) {
  const subfields: DeclarativeLeafField[] = field.fields ?? [];
  const values =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};

  function setSub(key: string, next: unknown) {
    onChange({ ...values, [key]: next });
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] bg-black/[0.015] p-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
      {subfields.map((sub) => (
        <LeafFieldControl
          key={sub.key}
          field={sub}
          value={values[sub.key]}
          onChange={(v) => setSub(sub.key, v)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
