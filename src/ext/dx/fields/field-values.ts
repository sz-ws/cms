import type { DeclarativeField, DeclarativeLeafField } from "../manifest";

// Tier 2 v1.2: shared value normalisation for a SINGLE field, extracted from
// FormView so the structural components (GroupField / RepeaterField /
// BlocksField) normalise their nested leaf subfields with the exact same
// stored ⇄ editor contract as top-level fields. One place = one behaviour at
// every nesting level.
//
// Two directions:
//   toFieldValue(field, stored)   → the editor-facing value the field
//                                    component's `value` prop expects.
//   buildFieldValue(field, editor)→ the stored value to persist, or `undefined`
//                                    to signal "empty — skip / sparse doc".
//
// Leaf shapes mirror content-provider.ts validateField and the doc value
// contract (dx-field-components.md). Structural fields carry their own nested
// object/array shape and are passed through untouched here — their components
// own the per-row/per-block normalisation and call these leaf helpers directly.

/** Build the editor value for one field from its stored data value. */
export function toFieldValue(field: DeclarativeField, v: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(v);
    case "date":
      return typeof v === "number"
        ? v
        : typeof v === "string" && Number.isFinite(Date.parse(v))
          ? Date.parse(v)
          : undefined;
    case "number":
      return typeof v === "number" ? v : undefined;
    case "json":
    case "richtext":
      // richtext value is a Tiptap JSON doc object (or legacy string/
      // undefined); pass through untouched — never String() it.
      return v;
    case "relation":
      // 08 §1: single entry id string (or "" when unset).
      return typeof v === "string" ? v : "";
    case "relations":
      // 08 §1: ordered array of entry id strings; drop non-strings defensively.
      return Array.isArray(v)
        ? v.filter((el): el is string => typeof el === "string")
        : [];
    case "group": {
      // Tier 2: nested subfield values → editor-shaped object (each subfield
      // run through toFieldValue so its component gets a proper editor value).
      const obj =
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : {};
      return toLeafValues(field.fields ?? [], obj);
    }
    case "repeater": {
      // Tier 2: ordered rows → each row's subfields run through toFieldValue.
      const rows = asObjectArray(v);
      return rows.map((row) => toLeafValues(field.fields ?? [], row));
    }
    case "blocks": {
      // Tier 2: ordered blocks → keep the `block` tag, run that block's leaf
      // subfields through toFieldValue. Unknown/typeless blocks pass through.
      const items = asObjectArray(v);
      const byName = new Map((field.blocks ?? []).map((b) => [b.name, b]));
      return items.map((item) => {
        const name = typeof item["block"] === "string" ? item["block"] : "";
        const def = byName.get(name);
        return {
          block: name,
          ...toLeafValues(def?.fields ?? [], item),
        };
      });
    }
    default:
      return v === undefined || v === null ? "" : String(v);
  }
}

/** Coerce an unknown value into an array of plain objects (drops non-objects). */
function asObjectArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (el): el is Record<string, unknown> =>
          el !== null && typeof el === "object" && !Array.isArray(el),
      )
    : [];
}

/**
 * Build the stored value for one field from its editor value. Returns
 * `undefined` when the field is empty and should be omitted (sparse doc). The
 * content-provider re-validates/normalises everything server-side; this is the
 * client-side shaping so the wire payload already matches the value contract.
 */
export function buildFieldValue(field: DeclarativeField, raw: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "date": {
      if (raw === undefined || raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined; // epoch ms
    }
    case "json":
      return raw === undefined ? undefined : raw;
    case "richtext":
      // Tiptap JSON doc (or legacy string) straight through; skip empty.
      return raw === undefined || raw === null || raw === "" ? undefined : raw;
    case "relation":
      // 08 §1: single entry id string. Empty = unset.
      return typeof raw === "string" && raw !== "" ? raw : undefined;
    case "relations": {
      // 08 §1: ordered array of entry id strings. Empty = unset.
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const ids = raw.filter(
        (el): el is string => typeof el === "string" && el.length > 0,
      );
      return ids.length > 0 ? ids : undefined;
    }
    case "group": {
      // Tier 2: editor-shaped object → stored object via buildLeafValues
      // (drops empty subfields). Empty group = unset.
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
      const stored = buildLeafValues(
        field.fields ?? [],
        raw as Record<string, unknown>,
      );
      return Object.keys(stored).length > 0 ? stored : undefined;
    }
    case "repeater": {
      // Tier 2: ordered rows → each row via buildLeafValues; keep order. Empty
      // list = unset. Individual rows may be sparse (that's fine).
      const rows = asObjectArray(raw);
      if (rows.length === 0) return undefined;
      return rows.map((row) => buildLeafValues(field.fields ?? [], row));
    }
    case "blocks": {
      // Tier 2: ordered blocks → keep `block` tag + that block's stored leaves.
      // Drop blocks with no/unknown type. Empty list = unset.
      const items = asObjectArray(raw);
      const byName = new Map((field.blocks ?? []).map((b) => [b.name, b]));
      const built: Record<string, unknown>[] = [];
      for (const item of items) {
        const name = typeof item["block"] === "string" ? item["block"] : "";
        const def = byName.get(name);
        if (!def) continue; // unknown/typeless block → drop
        built.push({ block: name, ...buildLeafValues(def.fields, item) });
      }
      return built.length > 0 ? built : undefined;
    }
    default: {
      const s = raw === undefined || raw === null ? "" : String(raw);
      return s === "" ? undefined : s;
    }
  }
}

/**
 * Normalise a whole stored data object into editor values for a set of leaf
 * fields (used by group/repeater/blocks to seed each row/block instance).
 */
export function toLeafValues(
  fields: readonly DeclarativeLeafField[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.key] = toFieldValue(f, data[f.key]);
  return out;
}

/**
 * Build the stored data object from editor values for a set of leaf fields.
 * Omits empty fields (sparse doc), matching buildFieldValue's contract.
 */
export function buildLeafValues(
  fields: readonly DeclarativeLeafField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const built = buildFieldValue(f, values[f.key]);
    if (built !== undefined) out[f.key] = built;
  }
  return out;
}
