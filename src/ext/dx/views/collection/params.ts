import type { ContentFilterValue } from "../../../capabilities";
import type { DeclarativeField } from "../../manifest";
import { coversAllStatuses, parseStatusList } from "@/lib/status-filter";

// collection view 的 URL state 解析 / 序列化。分頁·排序·filter 全部住在 searchParams,
// server component 讀取後餵給 query(),互動控制件只改 searchParams(router)。

export const DEFAULT_PER_PAGE = 20;
export const PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;
export const PER_PAGE_CAP = 100;

/** 內容的狀態,照篩選列的順序。 */
export const CONTENT_STATUSES = ["published", "draft"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
/**
 * 1.56.0:狀態篩選可以一次勾好幾個(lib/status-filter.ts)。空陣列 = 全部。
 * 以前是單選的 "all" | "draft" | "published";舊網址的 ?status=draft 照收。
 */
export type StatusFilter = ContentStatus[];
export type SortDir = "asc" | "desc";

export interface CollectionState {
  page: number;
  perPage: number;
  sort?: { field: string; dir: SortDir };
  status: StatusFilter;
  /** select 欄位 key → 選定 option(等值 filter)。 */
  selects: Record<string, string>;
  /** 主 text 欄位的 contains 搜尋字串(空 = 無)。 */
  search: string;
  searchField?: string;
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 從 searchParams 解出 collection state。selectFields 用來只接受合法的 select
 * filter key,searchField 指定 text-search 綁定的欄位 key。
 */
export function parseState(
  // Next 的 searchParams 遇到重複參數(?status=a&status=b)給的是陣列。
  sp: Record<string, string | string[] | undefined>,
  opts: {
    selectFields: DeclarativeField[];
    searchField?: string;
    sortableKeys: Set<string>;
  },
): CollectionState {
  const one = (key: string): string | undefined => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const page = toInt(one("page"), 1);
  const perPageRaw = toInt(one("perPage"), DEFAULT_PER_PAGE);
  const perPage = Math.min(Math.max(1, perPageRaw), PER_PAGE_CAP);

  let sort: CollectionState["sort"];
  const sortKey = one("sort");
  if (sortKey && opts.sortableKeys.has(sortKey)) {
    sort = { field: sortKey, dir: one("dir") === "asc" ? "asc" : "desc" };
  }

  const status: StatusFilter = parseStatusList(sp.status, CONTENT_STATUSES);

  const selects: Record<string, string> = {};
  for (const f of opts.selectFields) {
    const raw = one(`f_${f.key}`);
    if (raw && (f.options ?? []).includes(raw)) selects[f.key] = raw;
  }

  const search = (one("q") ?? "").slice(0, 100);

  return {
    page,
    perPage,
    sort,
    status,
    selects,
    search,
    searchField: opts.searchField,
  };
}

/** state → ContentProvider filter 物件。 */
export function toFilter(state: CollectionState): Record<string, ContentFilterValue> {
  const filter: Record<string, ContentFilterValue> = {};
  // 內容只有兩種狀態(capabilities 的 ContentEntry.status):勾一個才需要條件,
  // 兩個都勾等於全部 —— 所以不必讓 provider 的 filter 支援 IN。
  if (!coversAllStatuses(state.status, CONTENT_STATUSES) && state.status.length === 1) {
    filter.status = state.status[0];
  }
  for (const [key, value] of Object.entries(state.selects)) filter[key] = value;
  if (state.search && state.searchField) {
    filter[state.searchField] = { contains: state.search };
  }
  return filter;
}
