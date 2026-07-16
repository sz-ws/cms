"use client";

import { PlusIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeclarativeBlockDef } from "../manifest";
import type { FieldComponentProps } from "./types";
import { LeafFieldControl } from "./LeafFieldControl";
import {
  AddButton,
  InstanceCard,
  firstSummary,
  reorder,
} from "./structural-parts";

// Tier 2 v1.2: blocks field — the AI-declarable "page builder" primitive.
// Manifest declares named block shapes; the editor is a block-type chooser +
// repeater. Stored value: [{ block: "quote", … }, …] (ordered). Each instance
// carries a `block` tag naming which declared shape it is; its body renders
// that block's leaf subfields. Add / remove / reorder (up-down). One level of
// nesting (v1): a block's subfields are leaf types only.
//
// Chooser: with a single declared block, "Add <label>" is a plain button; with
// several, a dropdown menu lists each block by label. Value is EDITOR-shaped
// (each instance = { block, …editor subfield values }); mutations are immutable.

type BlockInstance = Record<string, unknown>;

export function BlocksField({
  value,
  onChange,
  field,
  disabled,
}: FieldComponentProps<BlockInstance[]>) {
  const defs: DeclarativeBlockDef[] = field.blocks ?? [];
  const byName = new Map(defs.map((b) => [b.name, b]));
  const items: BlockInstance[] = Array.isArray(value)
    ? value.filter(
        (b): b is BlockInstance =>
          b !== null && typeof b === "object" && !Array.isArray(b),
      )
    : [];
  const max = typeof field.max === "number" ? field.max : undefined;
  const atMax = max !== undefined && items.length >= max;

  function addBlock(name: string) {
    if (atMax || !byName.has(name)) return;
    onChange([...items, { block: name }]);
  }

  function removeAt(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }

  function move(i: number, dir: -1 | 1) {
    onChange(reorder(items, i, i + dir));
  }

  function setBlockSub(i: number, key: string, next: unknown) {
    onChange(items.map((b, idx) => (idx === i ? { ...b, [key]: next } : b)));
  }

  function blockLabel(def: DeclarativeBlockDef): string {
    return def.label ?? def.name;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {items.length > 0 && (
        <ol className="flex flex-col gap-2.5">
          {items.map((item, i) => {
            const name = typeof item["block"] === "string" ? item["block"] : "";
            const def = byName.get(name);
            const subfields = def?.fields ?? [];
            return (
              <InstanceCard
                key={i}
                index={i}
                count={items.length}
                tag={def ? blockLabel(def) : name || "unknown"}
                summary={firstSummary(subfields, item)}
                disabled={disabled}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => removeAt(i)}
              >
                {def ? (
                  subfields.map((sub) => (
                    <LeafFieldControl
                      key={sub.key}
                      field={sub}
                      value={item[sub.key]}
                      onChange={(v) => setBlockSub(i, sub.key, v)}
                      disabled={disabled}
                    />
                  ))
                ) : (
                  <p className="text-[13px] text-black/45">
                    Unknown block type “{name}”. Remove it, or restore its
                    definition in the manifest.
                  </p>
                )}
              </InstanceCard>
            );
          })}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <BlockChooser
          defs={defs}
          disabled={disabled || atMax}
          onAdd={addBlock}
          labelOf={blockLabel}
        />
        {max !== undefined && (
          <span className="text-[12px] tabular-nums text-black/35">
            {items.length} / {max}
          </span>
        )}
      </div>
    </div>
  );
}

function BlockChooser({
  defs,
  disabled,
  onAdd,
  labelOf,
}: {
  defs: DeclarativeBlockDef[];
  disabled?: boolean;
  onAdd: (name: string) => void;
  labelOf: (def: DeclarativeBlockDef) => string;
}) {
  if (defs.length === 0) return null;
  // Single declared block: a plain add button (no menu needed).
  if (defs.length === 1) {
    const only = defs[0];
    return (
      <AddButton
        label={`Add ${labelOf(only)}`}
        disabled={disabled}
        onClick={() => onAdd(only.name)}
      />
    );
  }
  // Several blocks: dropdown chooser.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={disabled}
        className="inline-flex h-10 w-fit items-center gap-1.5 rounded-[10px] bg-white px-3.5 text-[13px] font-medium text-black/75 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color] outline-none hover:bg-black/[0.03] focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 motion-reduce:active:scale-100"
      >
        <PlusIcon className="size-3.5" />
        Add block
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        {defs.map((def) => (
          <DropdownMenuItem key={def.name} onClick={() => onAdd(def.name)}>
            {labelOf(def)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
