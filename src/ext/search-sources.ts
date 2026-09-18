import type { LocalizedString } from "@/lib/i18n/localized";
import {
  OPEN_PARAM,
  recordSearchClauses,
  type AdminPageSearch,
  type GlobalSearchSource,
  type RecordSearchFields,
} from "./record-search";

// 1.40.0:⌘K 全站搜尋的 extension 來源。
//
// 來源不是另外宣告的:插件在 adminPages[].search 加 `global`(record-search.ts),
// 這一頁的可搜欄位就同時進 ⌘K,點結果回到這一頁並帶 `?q=<key>&open=<key>`。只給
// admin —— 這些表大多是訂單、客戶、帳務,editor 平常就進不了對應的後台頁。宣告的
// 驗證在 types.ts(defineExtension 時就擋)。

export interface ActiveSearchSource {
  /** `<extId>:<global.id>`。 */
  ref: string;
  extId: string;
  source: GlobalSearchSource;
  fields: RecordSearchFields;
  /** 宣告這個來源的後台頁,如 /admin/ext/shop。 */
  pageHref: string;
}

interface SearchableExtension {
  id: string;
  adminPages?: readonly { slug: string; search?: AdminPageSearch }[];
}

/** 啟用中的 extensions → 生效的來源(去掉被 `replaces` 取代的、同 ref 重複的)。 */
export function activeSearchSources(exts: readonly SearchableExtension[]): ActiveSearchSource[] {
  const all = exts.flatMap((ext) =>
    (ext.adminPages ?? []).flatMap((page) =>
      page.search?.global
        ? [
            {
              ref: `${ext.id}:${page.search.global.id}`,
              extId: ext.id,
              source: page.search.global,
              fields: page.search.fields,
              pageHref: `/admin/ext/${ext.id}${page.slug ? `/${page.slug}` : ""}`,
            },
          ]
        : [],
    ),
  );
  const replaced = new Set(all.map((entry) => entry.source.replaces).filter(Boolean));
  const seen = new Set<string>();
  return all.filter((entry) => {
    if (replaced.has(entry.ref) || seen.has(entry.ref)) return false;
    seen.add(entry.ref);
    return true;
  });
}

export interface RecordSearchHit {
  kind: "record";
  id: string;
  /** `<extId>:<sourceId>`。 */
  typeKey: string;
  typeLabel: string;
  title: string;
  snippet: string;
  editHref: string;
}

interface Db {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
}

/**
 * 對每個來源各查最新 `perSource` 筆。一個來源失敗(表還沒建、欄位改名)只略過
 * 那一個,不拖垮整個 ⌘K。
 */
export async function searchRecordSources(
  db: Db,
  sources: readonly ActiveSearchSource[],
  q: string,
  resolve: (value: LocalizedString) => string,
  perSource = 5,
): Promise<RecordSearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  const batches = await Promise.all(
    sources.map(async ({ ref, source, fields, pageHref }) => {
      try {
        const { clauses, args } = recordSearchClauses(fields, { q: query });
        if (clauses.length === 0) return [];
        const subtitle = source.subtitle ?? [];
        const columns = [
          `${source.key} AS k`,
          `${source.title} AS t`,
          ...subtitle.map((name, i) => `${name} AS s${i}`),
        ].join(", ");
        const order = fields.date ? `ORDER BY ${fields.date} DESC` : "";
        const { results } = await db
          .prepare(`SELECT ${columns} FROM ${source.table} WHERE ${clauses.join(" AND ")} ${order} LIMIT ?`)
          .bind(...args, perSource)
          .all<Record<string, unknown>>();
        const label = resolve(source.label);
        return results.map((row) => {
          const key = String(row.k ?? "");
          return {
            kind: "record" as const,
            id: key,
            typeKey: ref,
            typeLabel: label,
            title: String(row.t ?? key),
            snippet: subtitle
              .map((_, i) => row[`s${i}`])
              .filter((value) => value !== null && value !== undefined && value !== "")
              .map(String)
              .join(" · "),
            editHref: `${pageHref}?${new URLSearchParams({ q: key, [OPEN_PARAM]: key })}`,
          };
        });
      } catch (error) {
        console.error(`[search] source ${ref} failed`, error);
        return [];
      }
    }),
  );
  return batches.flat();
}
