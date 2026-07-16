"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, ArrowDownIcon, XIcon } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import type { FieldComponentProps } from "./types";
import {
  resolveRelationOptions,
  searchRelationOptions,
  type RelationOption,
} from "./relation-options";

// 08 §1/§2: relations field — ordered multi entry picker over another content
// type. Stored value: an ordered array of entry id strings (["id1","id2"]).
// Picking an entry appends it (dedup); an ordered chip list below shows each
// selection with reorder + remove controls.
//
// Reordering: @dnd-kit is NOT installed (no new deps this phase), so reordering
// uses explicit up/down buttons rather than drag-and-drop. Insertion order is
// otherwise preserved verbatim. A dnd upgrade is a follow-up.
//
// setState-in-effect note: the mount-time id → title resolve NEVER calls
// setState synchronously in the effect body — writes happen only inside the
// async `.then(...)` after the fetch settles, guarded by an `active` flag.

const SEARCH_DEBOUNCE_MS = 200;

/** Move item at `from` to `to` in a fresh array (immutable). */
function reorder(ids: readonly string[], from: number, to: number): string[] {
  if (to < 0 || to >= ids.length || from === to) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function RelationsField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string[]>) {
  const to = field.to ?? "";
  const ids = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

  const [items, setItems] = useState<RelationOption[]>([]);
  // id → title for every selected id (populated by the resolve effect + picks).
  const [titles, setTitles] = useState<Record<string, string>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve every selected id whose title we don't already know. No synchronous
  // setState in the effect body (see file header) — only inside `.then`.
  const idsKey = ids.join(",");
  useEffect(() => {
    const missing = ids.filter((id) => !(id in titles));
    if (missing.length === 0) return;
    let active = true;
    const controller = new AbortController();
    void resolveRelationOptions(to, missing, controller.signal).then((opts) => {
      if (!active) return;
      setTitles((prev) => {
        const next = { ...prev };
        for (const id of missing) {
          const found = opts.find((o) => o.id === id);
          next[id] = found ? found.title : id; // fall back to raw id
        }
        return next;
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
    // titles intentionally omitted: re-run keyed on the selected id set only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, to]);

  function runSearch(query: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      void searchRelationOptions(to, query, controller.signal).then((opts) => {
        setItems(opts);
      });
    }, SEARCH_DEBOUNCE_MS);
  }

  function addOption(opt: RelationOption | null) {
    if (!opt || ids.includes(opt.id)) return;
    setTitles((prev) => ({ ...prev, [opt.id]: opt.title }));
    onChange([...ids, opt.id]);
  }

  function removeAt(index: number) {
    onChange(ids.filter((_, i) => i !== index));
  }

  function move(index: number, dir: -1 | 1) {
    onChange(reorder(ids, index, index + dir));
  }

  return (
    <div className="flex flex-col gap-2">
      <Combobox<RelationOption>
        items={items}
        value={null} // picker never shows a selection; picks append to the list
        onValueChange={addOption}
        onInputValueChange={runSearch}
        onOpenChange={(open) => {
          if (open && items.length === 0) runSearch("");
        }}
        itemToStringLabel={(o) => o.title}
        isItemEqualToValue={(a, b) => a.id === b.id}
        filter={null}
        disabled={disabled}
      >
        <ComboboxInput
          id={`field-${field.key}`}
          placeholder="Search to add…"
          aria-invalid={Boolean(error)}
        />
        <ComboboxContent>
          <ComboboxEmpty>No matches.</ComboboxEmpty>
          <ComboboxList>
            {(item: RelationOption) => (
              <ComboboxItem key={item.id} value={item}>
                {item.title}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {ids.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {ids.map((id, i) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-2xl bg-black/[0.04] py-1.5 pr-1.5 pl-3 text-sm text-black/85"
            >
              <span className="min-w-4 text-[12px] tabular-nums text-black/35">
                {i + 1}
              </span>
              <span className="flex-1 truncate">{titles[id] ?? id}</span>
              <ReorderButton
                label="Move up"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUpIcon className="size-3.5" />
              </ReorderButton>
              <ReorderButton
                label="Move down"
                disabled={disabled || i === ids.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDownIcon className="size-3.5" />
              </ReorderButton>
              <ReorderButton
                label="Remove"
                disabled={disabled}
                onClick={() => removeAt(i)}
              >
                <XIcon className="size-3.5" />
              </ReorderButton>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ReorderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded-full text-black/45 transition-colors hover:bg-black/[0.06] hover:text-black/70 active:scale-[0.92] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
