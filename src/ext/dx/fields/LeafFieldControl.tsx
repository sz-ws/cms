"use client";

import { Label } from "@/components/ui/label";
import type { DeclarativeLeafField } from "../manifest";
import { fieldLabel } from "../views/field-utils";
import { FIELD_COMPONENTS } from "./index";
import type { ErasedFieldComponentProps } from "./index";
import { SlugField } from "./SlugField";

// Tier 2 v1.2: renders ONE leaf subfield (label + control) inside a structural
// field (group / repeater row / block instance). It recurses through the SAME
// FIELD_COMPONENTS map the top-level FormView uses — so a `select` subfield
// renders the real SelectField, a `media` subfield the real MediaField, etc.
// The unified value/onChange contract holds at every nesting level.
//
// Only leaf types reach here (v1 one-level-nesting bound: group/repeater/blocks
// contain leaf fields only — see manifest.ts leafFieldsSchema). `slug` keeps
// its FormView special-case (needs the sourceValue wiring); inside a structural
// field there is no slugField source, so it renders standalone.

export interface LeafFieldControlProps {
  field: DeclarativeLeafField;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  /** Per-subfield error (path-keyed message from the last submit's 400). */
  error?: string;
  /** Hide the label row (row summary already shows position/title). */
  hideLabel?: boolean;
}

export function LeafFieldControl({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
}: LeafFieldControlProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {!hideLabel && field.type !== "boolean" && (
        <Label htmlFor={`field-${field.key}`}>
          {fieldLabel(field)}
          {field.required && <span className="text-destructive"> *</span>}
        </Label>
      )}
      <LeafControl
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        error={error}
      />
      {field.type === "boolean" && !hideLabel && (
        <span className="text-[13px] text-black/55">{fieldLabel(field)}</span>
      )}
      {error && (
        <p className="rounded-[8px] border border-red-600/15 bg-red-50 px-2.5 py-1.5 text-[13px] normal-case text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function LeafControl({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: DeclarativeLeafField;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  error?: string;
}) {
  if (field.type === "slug") {
    return (
      <SlugField
        field={field}
        value={typeof value === "string" ? value : ""}
        onChange={onChange as (v: string) => void}
        error={error}
        disabled={disabled}
      />
    );
  }

  const Component = FIELD_COMPONENTS[field.type] as
    | React.ComponentType<ErasedFieldComponentProps>
    | undefined;

  if (!Component) {
    // Unknown leaf type: text fallback, never crash the form.
    return (
      <input
        id={`field-${field.key}`}
        className="h-9 w-full rounded-3xl border border-input bg-input/50 px-3 text-sm"
        value={typeof value === "string" ? value : String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <Component
      field={field}
      value={value}
      onChange={onChange}
      disabled={disabled}
      error={error}
    />
  );
}
