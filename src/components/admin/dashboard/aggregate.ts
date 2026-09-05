import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getExtRuntime } from "@/ext/loader";
import type { DeclarativeContentType } from "@/ext/dx/manifest";
import {
  listDeclarativeTypes,
  type DeclarativeTypeInfo,
} from "@/ext/dx/type-directory";
import { displayValue } from "@/ext/dx/views/field-utils";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/index";
import {
  getDashboardContentSnapshot,
  type DashboardRecentRow,
} from "./snapshot";

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
  // 沒有任何欄位的型別回空字串而不是炸掉:這個 key 現在對「全部」型別都會算一次
  // (要餵給 snapshot 做 data 裁切),不再只算有 recent 列的那些。
  return (firstText ?? ct.fields[0])?.key ?? "";
}

/** Snapshot row → dashboard recent card。 */
function recentFromSnapshot(
  entry: DashboardRecentRow,
  t: DashboardType,
): RecentEntry {
  const titleKey = titleFieldKey(t.contentType);
  const titleField = t.contentType.fields.find((f) => f.key === titleKey);
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
}

/**
 * Aggregate the whole dashboard server-side.
 *
 * Query count:content counts + recent 固定走一次 D1 batch(兩條 statement)，不再隨
 * content type 數量線性成長；user count 保留一條即時查詢，避免 user mutation 還要
 * 多維護一套 dashboard cache invalidation。
 */
export async function getDashboardData(): Promise<DashboardData> {
  // Ensure the extension runtime is warm (hooks/registry) — harmless, and keeps
  // the provider consistent with the CRUD/collection code paths.
  await getExtRuntime();

  const locale = await getLocale();
  const [types, userRows] = await Promise.all([
    listDashboardTypes(locale),
    db().select({ n: sql<number>`count(*)` }).from(users),
  ]);

  const userCount = userRows[0]?.n ?? 0;
  // 一起把標題欄位 key 交給 snapshot:recent 卡片只讀得到這一格,讓查詢端當場把
  // document 裁到只剩它,快取裡就不會躺著一份草稿內文(見 snapshot.pickTitleOnly)。
  const snapshot = await getDashboardContentSnapshot(
    types.map((type) => ({
      typeKey: type.typeKey,
      titleKey: titleFieldKey(type.contentType),
    })),
  );
  const countByType = new Map(snapshot.counts.map((row) => [row.type, row]));
  const typeByKey = new Map(types.map((type) => [type.typeKey, type]));

  const statList: DashboardTypeStats[] = types.map((type) => {
    const count = countByType.get(type.typeKey);
    const total = count?.total ?? 0;
    const published = count?.published ?? 0;
    return {
      ...type,
      total,
      published,
      drafts: Math.max(0, total - published),
    };
  });
  const recent = snapshot.recent
    .map((entry) => {
      const type = typeByKey.get(entry.type);
      return type ? recentFromSnapshot(entry, type) : null;
    })
    .filter((entry): entry is RecentEntry => entry !== null)
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
