// Pure value-comparison helpers for FormView's unsaved-changes (dirty) guard.
//
// Why this exists: FormView decides "dirty" by comparing the current field
// values against the snapshot captured on mount. Several field editors re-emit
// their value on mount without any user input — Tiptap's `onUpdate` normalises
// the doc and fires `onChange` with a FRESH doc object that is *deeply equal*
// to the seed, and the structural editors (group/repeater/blocks) rebuild their
// object/array value on every change. A naive per-key `!==` reference check
// mistook those no-op re-emits for real edits, so opening a Gallery / Pages
// entry lit "Unsaved changes" with nothing touched, and Discard could never
// clear it (the editor immediately re-emitted a fresh reference again).
//
// The fix is symmetric normalisation + structural deep-equality: normalise BOTH
// sides through the same rules (empty ⇄ absent, empty Tiptap doc ⇄ nothing,
// missing key ⇄ empty value) then compare by value. A re-emit that produces the
// same content is never dirty, at any nesting level; a genuine edit still is.

// Sentinel for "no meaningful value" — undefined, null, "", NaN, empty doc,
// empty array/object all collapse to this so absence and emptiness compare equal.
const EMPTY = Symbol("empty");

/** True when `v` is a Tiptap doc whose content is empty (mirrors
 * richtext-schema.isEmptyDoc, kept local so this stays a dependency-free pure
 * module the vitest workers pool can import without pulling in Tiptap). */
function isEmptyTiptapDoc(v: Record<string, unknown>): boolean {
  if (v.type !== "doc") return false;
  const content = v.content;
  return !Array.isArray(content) || content.length === 0;
}

/**
 * Canonicalise a single value for dirty comparison. Empties (undefined/null/
 * ""/NaN/empty doc/empty array/empty object) all become the EMPTY sentinel;
 * object keys with an EMPTY value are dropped so `{ a: "" }`, `{}` and
 * `undefined` all compare equal ("空值歸一 + 缺鍵補預設"). Non-empty values keep
 * their structure so genuine edits still differ.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return EMPTY;
  if (typeof value === "string") return value === "" ? EMPTY : value;
  if (typeof value === "number") return Number.isNaN(value) ? EMPTY : value;
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value.map(normalizeValue);
    // Ordered: keep positions (a real reorder/insert stays a change), but an
    // all-absent list collapses to EMPTY so `[]` ⇄ unset.
    return items.every((el) => el === EMPTY) ? EMPTY : items;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isEmptyTiptapDoc(obj)) return EMPTY;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const n = normalizeValue(obj[key]);
      if (n !== EMPTY) out[key] = n;
    }
    return Object.keys(out).length === 0 ? EMPTY : out;
  }

  return value;
}

/** Structural deep-equality over already-normalised values (primitives,
 * booleans, the EMPTY sentinel, arrays, and plain objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const key of keys) {
      if (!deepEqual(ao[key], bo[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * True when two field-value maps are equal after symmetric normalisation, i.e.
 * saving `a` would produce the same entry as `b`. FormView's dirty flag is the
 * negation of this against the mount snapshot.
 */
export function sameFieldValues(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return deepEqual(normalizeValue(a), normalizeValue(b));
}
