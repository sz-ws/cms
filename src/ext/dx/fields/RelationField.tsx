"use client";

import { useEffect, useRef, useState } from "react";
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

// 08 §1/§2: relation field — single entry picker over another content type.
// Reuses the base-ui Combobox primitive (same family as SelectField), but the
// item list is fetched async from the target type's /options endpoint rather
// than a static manifest `options` array. Stored value: a single entry id
// string (or "" when cleared). Paper & Ink via the shared combobox styling.
//
// setState-in-effect note: the effect that resolves the initial id → title
// NEVER calls setState synchronously in its body. The only setState calls live
// inside the async `resolve(...).then(...)` callback, after the fetch settles,
// guarded by an `active` flag so a unmount/id-change cancels the stale write.

const SEARCH_DEBOUNCE_MS = 200;

export function RelationField({
  value,
  onChange,
  field,
  error,
  disabled,
}: FieldComponentProps<string>) {
  const to = field.to ?? "";
  const selectedId = typeof value === "string" ? value : "";

  // Fetched search results shown in the popup (we control filtering; the
  // combobox's internal filter is disabled via filter={null}).
  const [items, setItems] = useState<RelationOption[]>([]);
  // Resolved-title CACHE keyed by id. The effect writes here (async only);
  // the combobox's displayed value is DERIVED from it below, so an empty
  // selection never needs a synchronous setState to "reset" anything.
  const [titles, setTitles] = useState<Record<string, string>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the selected id → its title whenever the stored id changes and we
  // don't already know it. No synchronous setState in the effect body — the
  // only write is inside the async `.then` (guarded by `active`). The empty-id
  // case does nothing here; the derived `selected` below handles display.
  useEffect(() => {
    if (selectedId === "" || selectedId in titles) return;
    let active = true;
    const controller = new AbortController();
    void resolveRelationOptions(to, [selectedId], controller.signal).then(
      (opts) => {
        if (!active) return;
        const found = opts.find((o) => o.id === selectedId);
        setTitles((prev) => ({
          ...prev,
          // Fall back to the raw id as label if the entry is unresolvable.
          [selectedId]: found ? found.title : selectedId,
        }));
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
    // titles intentionally omitted: re-run keyed on the selected id / target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, to]);

  // Derived combobox value — null when nothing is selected, else the resolved
  // option (raw id as a placeholder title until the fetch lands).
  const selected: RelationOption | null =
    selectedId === ""
      ? null
      : { id: selectedId, title: titles[selectedId] ?? selectedId };

  // Prime the popup list once (empty query → recent entries), and re-fetch as
  // the user types. Kicked from the input handler, not an effect.
  function runSearch(query: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      void searchRelationOptions(to, query, controller.signal).then((opts) => {
        setItems(opts);
      });
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleValueChange(next: RelationOption | null) {
    if (next) {
      // Cache the freshly-picked title so the label shows immediately without
      // a resolve round-trip.
      setTitles((prev) => ({ ...prev, [next.id]: next.title }));
      onChange(next.id);
    } else {
      onChange("");
    }
  }

  return (
    <Combobox<RelationOption>
      items={items}
      value={selected}
      onValueChange={handleValueChange}
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
        placeholder="Search…"
        aria-invalid={Boolean(error)}
        showClear={Boolean(selectedId)}
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
  );
}
