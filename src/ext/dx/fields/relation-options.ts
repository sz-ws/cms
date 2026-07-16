// 08 §2:client-side helper for the relation/relations pickers. Talks to the
// target content type's auto-CRUD `/options` endpoint (see crud.ts) — the
// endpoint is cookie-auth'd + injection-safe (provider's parameterized LIKE),
// so this file only shapes URLs + parses the `{ options: {id,title}[] }` reply.
//
// The relation `to` is a full type key "<extId>.<typeName>" which may point at a
// DIFFERENT extension than the one being edited; we split it and hit that
// extension's route. No per-component fetch logic — RelationField and
// RelationsField both consume these two functions.

export interface RelationOption {
  id: string;
  title: string;
}

interface OptionsResponse {
  options?: unknown;
}

/** Parse "<extId>.<typeName>" → endpoint base, or null when malformed. */
function optionsBase(to: string): string | null {
  const dot = to.indexOf(".");
  if (dot <= 0 || dot >= to.length - 1) return null;
  const extId = to.slice(0, dot);
  const typeName = to.slice(dot + 1);
  if (extId.length === 0 || typeName.length === 0) return null;
  return `/api/ext/${encodeURIComponent(extId)}/${encodeURIComponent(typeName)}/options`;
}

/** Narrow an unknown JSON payload to a clean RelationOption[]. */
function parseOptions(json: unknown): RelationOption[] {
  const raw = (json as OptionsResponse | null)?.options;
  if (!Array.isArray(raw)) return [];
  const out: RelationOption[] = [];
  for (const el of raw) {
    if (
      el &&
      typeof el === "object" &&
      typeof (el as { id?: unknown }).id === "string" &&
      typeof (el as { title?: unknown }).title === "string"
    ) {
      out.push({ id: (el as RelationOption).id, title: (el as RelationOption).title });
    }
  }
  return out;
}

/**
 * Search the target type by title (`q`). Empty `q` → most recently updated few.
 * Returns [] on any failure (network / malformed `to`) — pickers degrade to an
 * empty list rather than throwing inside an event handler.
 */
export async function searchRelationOptions(
  to: string,
  q: string,
  signal?: AbortSignal,
): Promise<RelationOption[]> {
  const base = optionsBase(to);
  if (!base) return [];
  const url = `${base}?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    return parseOptions((await res.json()) as unknown);
  } catch {
    return [];
  }
}

/**
 * Resolve known ids → { id, title } for display of already-selected entries.
 * Batched via the endpoint's `?ids=` mode (one round-trip, capped server-side).
 */
export async function resolveRelationOptions(
  to: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<RelationOption[]> {
  const clean = ids.filter((s) => typeof s === "string" && s.length > 0);
  if (clean.length === 0) return [];
  const base = optionsBase(to);
  if (!base) return [];
  const url = `${base}?ids=${clean.map((s) => encodeURIComponent(s)).join(",")}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    return parseOptions((await res.json()) as unknown);
  } catch {
    return [];
  }
}
