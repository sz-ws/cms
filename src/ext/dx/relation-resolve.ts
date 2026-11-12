import { enabledCompatibleManifests } from "./enabled-manifests";
import { getContentProvider } from "./runtime";
import { parseManifest } from "./manifest";
import type { DeclarativeContentType } from "./manifest";
import { pickTitleField } from "./views/field-utils";
import { displayValue } from "./views/field-utils";
import { detailPath } from "./route-matcher";

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

interface TargetMeta {
  contentType: DeclarativeContentType;
  detailBase: string | null;
}

/** 一次讀取、一次 parse，同時取得 target type 與公開 detail route base。 */
async function loadTargetMeta(
  extId: string,
  typeName: string,
): Promise<TargetMeta | null> {
  // 2.0:目標插件要是 loader 會載入的(啟用且 coreApi 相容);不是的話它的 detail 路由不存在,
  // 只列標題、不給連結。
  const rows = await enabledCompatibleManifests(extId);
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
  const contentType = parsed.manifest.contentTypes?.find(
    (content) => content.name === typeName,
  );
  if (!contentType) return null;
  const detail = (parsed.manifest.publicRoutes ?? []).find(
    (r) => r.contentType === typeName && r.view === "detail",
  );
  let detailBase: string | null = null;
  if (detail) {
    const segments = detail.pattern.split("/").filter((s) => s.length > 0);
    segments.pop(); // drop the trailing :slug segment
    detailBase = `/${segments.join("/")}`;
  }
  return { contentType, detailBase };
}

export interface ResolveRelationsOptions {
  /**
   * 草稿預覽(編輯開了 draft mode,逐請求渲染、不會存起來)才帶 true:未發佈與查無
   * 的項目照樣列出,讓編輯看到自己選了什麼。缺省 = 公開頁:只列已發佈的項目。
   */
  includeDrafts?: boolean;
}

/** 與公開 list / detail view 同一判斷:status 是 published 才給訪客看。 */
function isPublished(entry: { status: string } | null): boolean {
  return entry?.status === "published";
}

/**
 * Resolve entry id(s) of a relation target to { id, title, href }. Order of the
 * input ids is preserved.
 *
 * Public pages (the default) get PUBLISHED target entries only: a draft or
 * missing related item is left out entirely, no title, no link. Visitors never
 * see a draft's title, and draft writes do not refresh the stored pages
 * (contentWritten in content-provider.ts), so a draft title there would also go stale. With
 * `includeDrafts` (draft preview) every id is listed; drafts get no href, and
 * missing ids fall back to the raw id.
 */
export async function resolveRelations(
  to: string,
  ids: readonly string[],
  options: ResolveRelationsOptions = {},
): Promise<ResolvedRelation[]> {
  const includeDrafts = options.includeDrafts === true;
  const clean = ids.filter((s) => typeof s === "string" && s.length > 0);
  if (clean.length === 0) return [];
  const parts = splitTo(to);
  if (!parts) {
    return includeDrafts ? clean.map((id) => ({ id, title: id, href: null })) : [];
  }

  const target = await loadTargetMeta(parts.extId, parts.typeName);
  const fullType = `${parts.extId}.${parts.typeName}`;
  const provider = await getContentProvider();

  const titleField = target
    ? pickTitleField(target.contentType.fields, target.contentType.slugField)
    : undefined;

  // N+1 caveat: one provider.get per id (bounded by the caller — a detail page
  // renders a handful of relations, not a table). A batched get-by-ids provider
  // method is the documented follow-up.
  const entries = await Promise.all(clean.map((id) => provider.get(fullType, id)));

  return clean.flatMap((id, i): ResolvedRelation[] => {
    const entry = entries[i];
    if (!includeDrafts && !isPublished(entry)) return [];
    if (!entry) return [{ id, title: id, href: null }];
    const rawTitle = titleField ? entry.data[titleField.key] : undefined;
    const title =
      (titleField ? displayValue(titleField, rawTitle) : "").trim() ||
      entry.slug ||
      entry.id;
    const href =
      target?.detailBase && entry.slug && isPublished(entry)
        ? detailPath(target.detailBase, entry.slug)
        : null;
    return [{ id, title, href }];
  });
}

interface RelationFieldLike {
  key?: string;
  type?: string;
  to?: string;
}

/**
 * 公開 Content API 用:relation / relations 欄位只留已發佈的關聯項目(與公開頁同一判斷)。
 * 單一 relation 指向未發佈項目 → 該欄不輸出(與沒填一樣);relations 濾掉未發佈的 id。
 * 回傳新的 entry,不改傳入的物件。同一個 id 在整個回應裡只查一次。
 */
export async function keepPublishedRelations<
  T extends { data: Record<string, unknown> },
>(fields: readonly RelationFieldLike[], entries: readonly T[]): Promise<T[]> {
  const relFields = fields.filter(
    (f): f is Required<RelationFieldLike> =>
      typeof f.key === "string" &&
      (f.type === "relation" || f.type === "relations") &&
      typeof f.to === "string" &&
      splitTo(f.to) !== null,
  );
  if (relFields.length === 0) return [...entries];

  const provider = await getContentProvider();
  const checked = new Map<string, Promise<boolean>>();
  const published = (type: string, id: string): Promise<boolean> => {
    const key = `${type}\u0000${id}`;
    let found = checked.get(key);
    if (!found) {
      found = provider.get(type, id).then(isPublished);
      checked.set(key, found);
    }
    return found;
  };

  return Promise.all(
    entries.map(async (entry) => {
      // 每個 relation 欄位的結果:null = 整欄拿掉,其餘 = 換成這個值。
      const kept = new Map<string, unknown>();
      await Promise.all(
        relFields.map(async (f) => {
          const value = entry.data[f.key];
          if (f.type === "relation") {
            if (typeof value !== "string" || value.length === 0) return;
            if (!(await published(f.to, value))) kept.set(f.key, null);
            return;
          }
          if (!Array.isArray(value)) return;
          const flags = await Promise.all(
            value.map((id) =>
              typeof id === "string" && id.length > 0 ? published(f.to, id) : false,
            ),
          );
          kept.set(f.key, value.filter((_, i) => flags[i]));
        }),
      );
      // 保留原本的欄位順序。
      const data = Object.fromEntries(
        Object.entries(entry.data).flatMap(([k, v]): [string, unknown][] => {
          if (!kept.has(k)) return [[k, v]];
          const next = kept.get(k);
          return next === null ? [] : [[k, next]];
        }),
      );
      return { ...entry, data };
    }),
  );
}
