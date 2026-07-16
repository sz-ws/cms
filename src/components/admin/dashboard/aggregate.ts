import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getExtRuntime } from "@/ext/loader";
import type { DeclarativeContentType } from "@/ext/dx/manifest";
import {
  listDeclarativeTypes,
  type DeclarativeTypeInfo,
} from "@/ext/dx/type-directory";
import { getContentProvider } from "@/ext/dx/runtime";
import { displayValue } from "@/ext/dx/views/field-utils";
import type { ContentProvider } from "@/ext/capabilities";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/index";

// Task #4: server-side aggregation for the content-aware dashboard. Everything
// here is driven by the enabled declarative extensions + the ContentProvider,
// so the dashboard reflects whatever content types exist with no per-extension
// code.
//
// NOTE ON CODE EXTENSIONS: code extensions store rows in their own typed
// tables, not in the shared `contents` table the ContentProvider reads. They
// therefore do NOT surface here yet — that's expected; they get ported to
// declarative in a later task. We deliberately do not special-case any single
// extension.

const RECENT_PER_TYPE = 10; // cap per-type fetch for the recent list (no unbounded N+1)
const RECENT_TOTAL = 9; // final merged recent-entries count

/** One declarative content type, resolved to its full type key + owning ext. */
// 型別目錄本體移到 src/ext/dx/type-directory.ts(server-safe,/api/search 共用);
// 這裡保留別名與轉呼叫,dashboard 呼叫端不動。
export type DashboardType = DeclarativeTypeInfo;

export interface DashboardTypeStats extends DashboardType {
  total: number;
  published: number;
  drafts: number;
}

export interface RecentEntry {
  id: string;
  title: string;
  typeLabel: string;
  extName: string;
  status: "draft" | "published";
  updatedAt: number;
  editHref: string;
}

export interface DashboardData {
  types: DashboardTypeStats[];
  recent: RecentEntry[];
  totalEntries: number;
  totalPublished: number;
  totalDrafts: number;
  typeCount: number;
  userCount: number;
  hasTypes: boolean;
  now: number; // server timestamp captured at aggregation time (for relative times)
}

/** 轉呼叫 type-directory(見上方註解)。type label / ext name 依 locale resolve。 */
export async function listDashboardTypes(
  locale: Locale = "en",
): Promise<DashboardType[]> {
  return listDeclarativeTypes(locale);
}

/** Primary text field for an entry's title (mirrors collection view's choice:
 * slugField text column, else first text column, else first field). */
function titleFieldKey(ct: DeclarativeContentType): string {
  const byslug = ct.fields.find(
    (f) => f.key === ct.slugField && f.type === "text",
  );
  if (byslug) return byslug.key;
  const firstText = ct.fields.find((f) => f.type === "text");
  return (firstText ?? ct.fields[0]).key;
}

/** total + published counts for a type via two capped count queries
 * (perPage:1 so we only read the `total`, never materialise rows). */
async function statsFor(
  provider: ContentProvider,
  t: DashboardType,
): Promise<DashboardTypeStats> {
  const [all, pub] = await Promise.all([
    provider.query(t.typeKey, { perPage: 1, page: 1 }),
    provider.query(t.typeKey, {
      filter: { status: "published" },
      perPage: 1,
      page: 1,
    }),
  ]);
  const total = all.total;
  const published = pub.total;
  return { ...t, total, published, drafts: Math.max(0, total - published) };
}

/** Newest entries for one type (capped), mapped to RecentEntry. */
async function recentFor(
  provider: ContentProvider,
  t: DashboardType,
): Promise<RecentEntry[]> {
  const { items } = await provider.query(t.typeKey, {
    sort: { field: "updatedAt", dir: "desc" },
    perPage: RECENT_PER_TYPE,
    page: 1,
  });
  const titleKey = titleFieldKey(t.contentType);
  const titleField = t.contentType.fields.find((f) => f.key === titleKey);
  return items.map((entry) => {
    const raw = entry.data[titleKey];
    const title = titleField
      ? displayValue(titleField, raw).trim()
      : String(raw ?? "");
    return {
      id: entry.id,
      title: title.length > 0 ? title : "Untitled",
      typeLabel: t.typeLabel,
      extName: t.extName,
      status: entry.status,
      updatedAt: entry.updatedAt,
      editHref: `${t.collectionHref}/edit?id=${encodeURIComponent(entry.id)}`,
    };
  });
}

/**
 * Aggregate the whole dashboard server-side.
 *
 * Query count: ~2 count queries per type (total + published) + 1 list query per
 * type for the recent feed + 1 users count. For N content types that is O(N)
 * round-trips — fine at admin scale on D1. SCALING CAVEAT: if a deployment ever
 * has many dozens of content types this fans out linearly; a future
 * optimisation could push the per-type totals into a single GROUP BY over
 * `contents.type`/`status` and merge the recent feed with one windowed query.
 */
export async function getDashboardData(): Promise<DashboardData> {
  // Ensure the extension runtime is warm (hooks/registry) — harmless, and keeps
  // the provider consistent with the CRUD/collection code paths.
  await getExtRuntime();

  const locale = await getLocale();
  const [types, provider, userRows] = await Promise.all([
    listDashboardTypes(locale),
    getContentProvider(),
    db().select({ n: sql<number>`count(*)` }).from(users),
  ]);

  const userCount = userRows[0]?.n ?? 0;

  const [statList, recentLists] = await Promise.all([
    Promise.all(types.map((t) => statsFor(provider, t))),
    Promise.all(types.map((t) => recentFor(provider, t))),
  ]);

  const recent = recentLists
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_TOTAL);

  const totalEntries = statList.reduce((s, t) => s + t.total, 0);
  const totalPublished = statList.reduce((s, t) => s + t.published, 0);
  const totalDrafts = Math.max(0, totalEntries - totalPublished);

  // Stable ordering: most-populated types first, then label.
  const sortedTypes = [...statList].sort(
    (a, b) => b.total - a.total || a.typeLabel.localeCompare(b.typeLabel),
  );

  return {
    types: sortedTypes,
    recent,
    totalEntries,
    totalPublished,
    totalDrafts,
    typeCount: types.length,
    userCount,
    hasTypes: types.length > 0,
    now: Date.now(),
  };
}
