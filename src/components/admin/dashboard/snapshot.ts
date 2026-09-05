import { unstable_cache } from "next/cache";
import { getDB } from "@/lib/cf";
import { contentTag } from "@/ext/dx/cache-tags";

const RECENT_TOTAL = 9;
const CACHE_SECONDS = 300;

export interface DashboardCountRow {
  type: string;
  total: number;
  published: number;
}

export interface DashboardRecentRow {
  id: string;
  type: string;
  slug: string | null;
  status: "draft" | "published";
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface DashboardContentSnapshot {
  counts: DashboardCountRow[];
  recent: DashboardRecentRow[];
}

/** 一個 content type 加上它的標題欄位 key(由 aggregate.ts 的 titleFieldKey 決定)。 */
export interface DashboardTypeTitleKey {
  typeKey: string;
  /** 空字串 = 該型別沒有任何欄位可當標題,recent 的 data 直接留空。 */
  titleKey: string;
}

interface RawCountRow {
  type: string;
  total: number | string;
  published: number | string;
}

interface RawRecentRow {
  id: string;
  type: string;
  slug: string | null;
  status: string;
  data: string;
  updated_at: number;
}

const EMPTY_SNAPSHOT: DashboardContentSnapshot = { counts: [], recent: [] };

function parseData(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Recent 卡片只用得到標題那一格,所以 document 在離開這個模組前就先縮到剩標題。
 * 這條 snapshot 會被 unstable_cache 整包序列化進 R2 incremental cache —— 帶著
 * 完整 data 等於把「還沒發佈的草稿內文」多存了一份到另一個儲存體,是新增的
 * 資料足跡,不是效能問題。SELECT 仍取 data:同一列的其他欄位(id/status/…)本來
 * 就要,再開一條只取單一 JSON 欄位的查詢並不會比較省。
 */
function pickTitleOnly(
  raw: string,
  titleKey: string,
): Record<string, unknown> {
  if (titleKey === "") return {};
  const parsed = parseData(raw);
  return titleKey in parsed ? { [titleKey]: parsed[titleKey] } : {};
}

/** 去重(同 typeKey 取第一筆)並依 typeKey 排序 —— 排序後才能當穩定的 cache key。 */
function normalizeTypes(
  types: readonly DashboardTypeTitleKey[],
): DashboardTypeTitleKey[] {
  const byKey = new Map<string, string>();
  for (const type of types) {
    if (!byKey.has(type.typeKey)) byKey.set(type.typeKey, type.titleKey);
  }
  return [...byKey.entries()]
    .map(([typeKey, titleKey]) => ({ typeKey, titleKey }))
    .sort((a, b) => (a.typeKey < b.typeKey ? -1 : a.typeKey > b.typeKey ? 1 : 0));
}

/**
 * Dashboard 的 content 數字只需要兩條 SQL，而且透過 D1 batch 在一次 round-trip
 * 完成：一條 GROUP BY 取所有 type/status counts；一條全域 LIMIT 9 取 recent。
 *
 * 舊路徑對每個 type 呼叫三次 provider.query()，而 provider.query 每次都做 rows +
 * COUNT，實際是 6N statements。這裡無論 type 數量都固定為 2 statements / 1 batch。
 */
export async function queryDashboardContentSnapshot(
  types: readonly DashboardTypeTitleKey[],
): Promise<DashboardContentSnapshot> {
  const normalized = normalizeTypes(types);
  if (normalized.length === 0) return EMPTY_SNAPSHOT;

  const keys = normalized.map((type) => type.typeKey);
  const titleKeyByType = new Map(
    normalized.map((type) => [type.typeKey, type.titleKey]),
  );
  const placeholders = keys.map(() => "?").join(", ");
  const binding = getDB();
  const countStmt = binding
    .prepare(
      `SELECT type,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published
         FROM contents
        WHERE type IN (${placeholders})
        GROUP BY type`,
    )
    .bind(...keys);
  const recentStmt = binding
    .prepare(
      `SELECT id, type, slug, status, data, updated_at
         FROM contents
        WHERE type IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .bind(...keys, RECENT_TOTAL);

  const [countResult, recentResult] = await binding.batch([
    countStmt,
    recentStmt,
  ]);
  const countRows = countResult.results as unknown as RawCountRow[];
  const recentRows = recentResult.results as unknown as RawRecentRow[];

  return {
    counts: countRows.map((row) => ({
      type: row.type,
      total: Number(row.total),
      published: Number(row.published),
    })),
    recent: recentRows.map((row) => ({
      id: row.id,
      type: row.type,
      slug: row.slug,
      status: row.status === "published" ? "published" : "draft",
      data: pickTitleOnly(row.data, titleKeyByType.get(row.type) ?? ""),
      updatedAt: row.updated_at,
    })),
  };
}

/**
 * Dashboard metrics 可以接受數分鐘的 stale-while-revalidate；content mutation 已會
 * revalidate 對應的 content:<type>，所以正常寫入後仍是 on-demand 更新。TTL 只負責
 * 防守繞過 provider 的人工 DB 寫入，以及讓孤兒 cache 最終收斂。
 */
export async function getDashboardContentSnapshot(
  types: readonly DashboardTypeTitleKey[],
): Promise<DashboardContentSnapshot> {
  const normalized = normalizeTypes(types);
  if (normalized.length === 0) return EMPTY_SNAPSHOT;

  try {
    const run = unstable_cache(
      () => queryDashboardContentSnapshot(normalized),
      [
        "dashboard-content-snapshot-v1",
        // titleKey 也進 cache key:標題欄位換了(改 slugField / 刪掉舊的 text 欄位)
        // 之後,舊 entry 存的是「照舊 titleKey 縮過的 data」,再拿來讀新 key 會全部
        // 變 Untitled。型別清單相同但形狀不同,只靠 typeKey 分不出來。
        JSON.stringify(
          normalized.map((type) => [type.typeKey, type.titleKey]),
        ),
      ],
      {
        tags: normalized.map((type) => contentTag(type.typeKey)),
        revalidate: CACHE_SECONDS,
      },
    );
    return await run();
  } catch (error) {
    console.error(
      "[dashboard:cache] snapshot cache failed; falling back to D1 batch",
      error,
    );
    return queryDashboardContentSnapshot(normalized);
  }
}
