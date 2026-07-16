"use client";

import dynamic from "next/dynamic";
import type { JSONContent } from "@tiptap/core";
import type { FieldComponentProps } from "./types";

// C.5b §1: richtext field. Stored value = Tiptap JSON document object
// (dx-field-components.md `richtext` row). The heavy Tiptap/ProseMirror editor
// lives in RichtextEditor and is loaded via next/dynamic (ssr:false) so it
// never ships to public pages or non-richtext admin forms.
//
// Back-compat: incoming `value` may be undefined, a legacy plain string, or a
// JSON doc — RichtextEditor.toDoc() normalises all three. The onChange always
// emits a JSON doc, so first save upgrades a legacy string to a doc.
//
// Value type here is `unknown` (the FormView holds field values as unknown and
// the FIELD_COMPONENTS map is type-erased); the editor narrows internally.

const RichtextEditor = dynamic(() => import("./RichtextEditor"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-52 items-center justify-center rounded-[10px] bg-white text-[13px] text-black/45 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]">
      Loading editor…
    </div>
  ),
});

export function RichtextField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<unknown>) {
  return (
    <RichtextEditor
      value={value}
      onChange={(doc: JSONContent) => onChange(doc)}
      disabled={disabled}
      invalid={Boolean(error)}
      fieldKey={field.key}
    />
  );
}
