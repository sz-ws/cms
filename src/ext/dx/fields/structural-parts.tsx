"use client";

import { ArrowUpIcon, ArrowDownIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

// Tier 2 v1.2: shared UI parts for RepeaterField + BlocksField. Both render an
// ordered list of instances (rows / blocks) with up/down reorder + remove
// controls. @dnd-kit is NOT installed (no new deps this phase) — reorder is
// explicit up/down buttons, same pattern as RelationsField. Paper & Ink:
// white/inset surfaces, shadow-ring instead of gray borders, concentric radii,
// active:scale feedback, no `transition: all`.

/** Move item at `from` to `to` in a fresh array (immutable). */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Small round icon button matching RelationsField's reorder controls. */
export function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-full text-black/45 transition-colors hover:bg-black/[0.06] hover:text-black/70 active:scale-[0.92] disabled:pointer-events-none disabled:opacity-30 motion-reduce:active:scale-100"
    >
      {children}
    </button>
  );
}

/**
 * A single instance card (repeater row / block instance): index badge, an
 * optional summary line + type tag in the header, the up/down/remove controls,
 * then the instance body (nested subfield controls) below.
 */
export function InstanceCard({
  index,
  count,
  summary,
  tag,
  disabled,
  onUp,
  onDown,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  summary?: string;
  tag?: string;
  disabled?: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-[14px] bg-white p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_6px_0_rgba(0,0,0,0.03)]">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[11px] tabular-nums text-black/45">
          {index + 1}
        </span>
        {tag && (
          <span className="inline-flex items-center rounded-[6px] bg-[rgb(86,114,228)]/[0.1] px-1.5 py-0.5 text-[11px] font-medium text-[rgb(86,114,228)]">
            {tag}
          </span>
        )}
        {summary !== undefined && (
          <span className="min-w-0 flex-1 truncate text-[13px] text-black/55">
            {summary || <span className="text-black/25">(empty)</span>}
          </span>
        )}
        <span className={summary === undefined ? "flex-1" : undefined} />
        <IconButton
          label="Move up"
          disabled={disabled || index === 0}
          onClick={onUp}
        >
          <ArrowUpIcon className="size-3.5" />
        </IconButton>
        <IconButton
          label="Move down"
          disabled={disabled || index === count - 1}
          onClick={onDown}
        >
          <ArrowDownIcon className="size-3.5" />
        </IconButton>
        <IconButton label="Remove" disabled={disabled} onClick={onRemove}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex flex-col gap-3 border-t border-black/[0.06] pt-3">
        {children}
      </div>
    </li>
  );
}

/** "Add" button used by repeater/blocks (disabled when max reached). */
export function AddButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 w-fit items-center gap-1.5 rounded-[10px] bg-white px-3.5 text-[13px] font-medium text-black/75 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[background-color] outline-none hover:bg-black/[0.03] focus-visible:shadow-[0_0_0_3px_rgba(86,114,228,0.35)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 motion-reduce:active:scale-100"
    >
      {label}
    </button>
  );
}

/**
 * First-non-empty-leaf summary for a row/block instance: mirrors the doc's
 * "row summary from first text subfield" — we take the first subfield that has
 * a renderable string value. Pure, no I/O.
 */
export function firstSummary(
  fields: readonly { key: string }[],
  values: Record<string, unknown>,
): string {
  for (const f of fields) {
    const v = values[f.key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}
