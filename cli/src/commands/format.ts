// Small text helpers shared by the report commands.

import { padVisual } from "../ui.js";

/** "2 hours ago", from an ISO time and now. */
export function ago(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** "2026-11-13 04:43 UTC". */
export function utc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A label column of fixed width, then the value; continuation lines indented to match. */
export function field(label: string, values: readonly string[], width = 11): string[] {
  return values.map((v, i) => `${padVisual(i === 0 ? label : "", width)}${v}`.trimEnd());
}

/** Join items with a separator, wrapping before `max` columns. */
export function wrapJoin(items: readonly string[], sep: string, max: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current === "" ? item : `${current}${sep}${item}`;
    if (current !== "" && next.length > max) {
      lines.push(current);
      current = item;
    } else current = next;
  }
  if (current !== "") lines.push(current);
  return lines;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
