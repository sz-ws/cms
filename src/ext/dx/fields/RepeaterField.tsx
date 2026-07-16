"use client";

import type { DeclarativeLeafField } from "../manifest";
import type { FieldComponentProps } from "./types";
import { LeafFieldControl } from "./LeafFieldControl";
import {
  AddButton,
  InstanceCard,
  firstSummary,
  reorder,
} from "./structural-parts";

// Tier 2 v1.2: repeater field — an ordered list of groups. Stored value:
// [{ … }, …] (ordered). Add / remove / reorder (up-down; @dnd-kit not installed
// this phase). `max` disables the add button once reached. Each row shows a
// summary from its first non-empty leaf subfield. One level of nesting (v1):
// subfields are leaf types only.
//
// Value contract: `value` is an EDITOR-shaped array of row objects (each a
// subfield-values object). Every mutation produces a fresh array/object
// (immutable) and calls onChange.

type Row = Record<string, unknown>;

export function RepeaterField({
  value,
  onChange,
  field,
  disabled,
}: FieldComponentProps<Row[]>) {
  const subfields: DeclarativeLeafField[] = field.fields ?? [];
  const rows: Row[] = Array.isArray(value)
    ? value.filter(
        (r): r is Row => r !== null && typeof r === "object" && !Array.isArray(r),
      )
    : [];
  const max = typeof field.max === "number" ? field.max : undefined;
  const atMax = max !== undefined && rows.length >= max;

  function addRow() {
    if (atMax) return;
    onChange([...rows, {}]);
  }

  function removeAt(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }

  function move(i: number, dir: -1 | 1) {
    onChange(reorder(rows, i, i + dir));
  }

  function setRowSub(i: number, key: string, next: unknown) {
    onChange(
      rows.map((r, idx) => (idx === i ? { ...r, [key]: next } : r)),
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.length > 0 && (
        <ol className="flex flex-col gap-2.5">
          {rows.map((row, i) => (
            <InstanceCard
              key={i}
              index={i}
              count={rows.length}
              summary={firstSummary(subfields, row)}
              disabled={disabled}
              onUp={() => move(i, -1)}
              onDown={() => move(i, 1)}
              onRemove={() => removeAt(i)}
            >
              {subfields.map((sub) => (
                <LeafFieldControl
                  key={sub.key}
                  field={sub}
                  value={row[sub.key]}
                  onChange={(v) => setRowSub(i, sub.key, v)}
                  disabled={disabled}
                />
              ))}
            </InstanceCard>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <AddButton
          label={rows.length === 0 ? "Add item" : "Add another"}
          disabled={disabled || atMax}
          onClick={addRow}
        />
        {max !== undefined && (
          <span className="text-[12px] tabular-nums text-black/35">
            {rows.length} / {max}
          </span>
        )}
      </div>
    </div>
  );
}
