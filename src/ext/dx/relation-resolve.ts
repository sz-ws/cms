import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions } from "@/lib/schema";
import { getContentProvider } from "./runtime";
import { parseManifest } from "./manifest";
import type { DeclarativeContentType } from "./manifest";
import { pickTitleField } from "./views/field-utils";
import { displayValue } from "./views/field-utils";

// 08 §2: SERVER-side relation resolution for the public DetailView. Turns a
// relation `to = "<extId>.<typeName>"` + entry id(s) into display titles and,
// when the target type exposes a public `detail` route, a link href.
//
// Runs inside a React server component, so it queries the ContentProvider and
// the declarative_extensions table directly — no HTTP round-trip. The target
// type may live in a DIFFERENT extension, so we read that extension's manifest
// to learn its title field + detail-route base.

export interface ResolvedRelation {
  id: string;
  title: string;
  href: string | null;
}

/** Split "<extId>.<typeName>" → parts, or null when malformed. */
function splitTo(to: string): { extId: string; typeName: string } | null {
  const dot = to.indexOf(".");
  if (dot <= 0 || dot >= to.length - 1) return null;
  return { extId: to.slice(0, dot), typeName: to.slice(dot + 1) };
}

/** Load + parse the target extension's manifest and pull the referenced type. */
async function loadTargetType(
  extId: string,
  typeName: string,
): Promise<DeclarativeContentType | null> {
  const rows = await db()
    .select({ manifest: declarativeExtensions.manifest })
    .from(declarativeExtensions)
    .where(eq(declarativeExtensions.id, extId))
    .limit(1);
  const raw = rows[0]?.manifest;
  if (!raw) return null; // v1: relations into code extensions are unsupported.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = parseManifest(json);
  if (!parsed.ok || !parsed.manifest) return null;
  return (
    parsed.manifest.contentTypes?.find((c) => c.name === typeName) ?? null
  );
}

/** Detail-route base ("/gallery") for a type, or null if it has no detail route. */
function detailBase(
  manifestJson: unknown,
  typeName: string,
): string | null {
  const parsed = parseManifest(manifestJson);
  if (!parsed.ok || !parsed.manifest) return null;
  const detail = (parsed.manifest.publicRoutes ?? []).find(
    (r) => r.contentType === typeName && r.view === "detail",
  );
  if (!detail) return null;
  const parts = detail.pattern.split("/").filter((s) => s.length > 0);
  parts.pop(); // drop the trailing :slug segment
  return `/${parts.join("/")}`;
}

/**
 * Resolve entry id(s) of a relation target to { id, title, href }. Only
 * PUBLISHED target entries get an href (drafts have no public page). Missing /
 * unresolvable ids fall back to showing the raw id with a null href. Order of
 * the input ids is preserved.
 */
export async function resolveRelations(
  to: string,
  ids: readonly string[],
): Promise<ResolvedRelation[]> {
  const clean = ids.filter((s) => typeof s === "string" && s.length > 0);
  if (clean.length === 0) return [];
  const parts = splitTo(to);
  if (!parts) return clean.map((id) => ({ id, title: id, href: null }));

  const targetType = await loadTargetType(parts.extId, parts.typeName);
  const fullType = `${parts.extId}.${parts.typeName}`;
  const provider = await getContentProvider();

  // Re-read the manifest once for the detail base (loadTargetType already
  // parsed it, but keep the concerns separate + cheap — one extra parse).
  const rows = await db()
    .select({ manifest: declarativeExtensions.manifest })
    .from(declarativeExtensions)
    .where(eq(declarativeExtensions.id, parts.extId))
    .limit(1);
  let base: string | null = null;
  if (rows[0]?.manifest) {
    try {
      base = detailBase(JSON.parse(rows[0].manifest) as unknown, parts.typeName);
    } catch {
      base = null;
    }
  }

  const titleField = targetType
    ? pickTitleField(targetType.fields, targetType.slugField)
    : undefined;

  // N+1 caveat: one provider.get per id (bounded by the caller — a detail page
  // renders a handful of relations, not a table). A batched get-by-ids provider
  // method is the documented follow-up.
  const entries = await Promise.all(clean.map((id) => provider.get(fullType, id)));

  return clean.map((id, i) => {
    const entry = entries[i];
    if (!entry) return { id, title: id, href: null };
    const rawTitle = titleField ? entry.data[titleField.key] : undefined;
    const title =
      (titleField ? displayValue(titleField, rawTitle) : "").trim() ||
      entry.slug ||
      entry.id;
    const href =
      base && entry.slug && entry.status === "published"
        ? `${base}/${entry.slug}`
        : null;
    return { id, title, href };
  });
}
