import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions as dxTable } from "@/lib/schema";
import { parseManifest } from "./manifest";
import type { DeclarativeContentType } from "./manifest";

// typeKey → admin 路徑/標籤的目錄(server-safe:只依賴 db/schema/manifest,
// 無任何 client 模組)。原本住在 dashboard 的 aggregate.ts,但 /api/search 也要
// 組 editHref —— aggregate 的 import 鏈(views/field-utils → next/navigation)在
// workers 測試池會炸,所以抽到這裡讓兩邊共用。

export interface DeclarativeTypeInfo {
  typeKey: string; // "<extId>.<typeName>"
  typeLabel: string; // human label (falls back to name)
  extId: string;
  extName: string;
  contentType: DeclarativeContentType;
  collectionHref: string; // /admin/ext/<extId>[/<slug>]
  newHref: string; // <collection>/edit
}

/**
 * The collection admin page for an extension lives at the FIRST adminPage whose
 * contentType matches (the interpreter builds a collection route per adminPage).
 * We look it up so hrefs point at real URLs. If none is declared (a content
 * type with no admin page), we fall back to the ext root — still navigable.
 */
function resolveCollectionSlug(
  manifestPages: { slug: string; contentType: string }[] | undefined,
  typeName: string,
): string {
  const page = (manifestPages ?? []).find((p) => p.contentType === typeName);
  return page?.slug ?? "";
}

/** Enumerate every declarative content type across all ENABLED declarative
 * extensions. Reads the stored rows directly (not the interpreted Extension
 * shape) so we keep manifest-level metadata like labels + admin slugs. */
export async function listDeclarativeTypes(): Promise<DeclarativeTypeInfo[]> {
  const rows = await db()
    .select({
      id: dxTable.id,
      manifest: dxTable.manifest,
    })
    .from(dxTable)
    .where(sql`${dxTable.enabled} = 1`);

  const types: DeclarativeTypeInfo[] = [];
  for (const row of rows) {
    let json: unknown;
    try {
      json = JSON.parse(row.manifest);
    } catch {
      continue; // malformed row: skip (loader logs elsewhere)
    }
    const parsed = parseManifest(json);
    if (!parsed.ok || !parsed.manifest) continue;
    const m = parsed.manifest;
    for (const ct of m.contentTypes ?? []) {
      const slug = resolveCollectionSlug(m.adminPages, ct.name);
      const base = `/admin/ext/${m.id}${slug ? `/${slug}` : ""}`;
      types.push({
        typeKey: `${m.id}.${ct.name}`,
        typeLabel: ct.label ?? ct.name,
        extId: m.id,
        extName: m.name,
        contentType: ct,
        collectionHref: base,
        newHref: `${base}/edit`,
      });
    }
  }
  return types;
}
