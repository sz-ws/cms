import type { ContentFilterValue } from "../../../capabilities";
import type { DeclarativeField } from "../../manifest";

// collection view 的 URL state 解析 / 序列化。分頁·排序·filter 全部住在 searchParams,
// server component 讀取後餵給 query(),互動控制件只改 searchParams(router)。

export const DEFAULT_PER_PAGE = 20;
export const PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;
export const PER_PAGE_CAP = 100;

export type StatusFilter = "all" | "draft" | "published";
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
  sp: Record<string, string>,
  opts: {
    selectFields: DeclarativeField[];
    searchField?: string;
    sortableKeys: Set<string>;
  },
): CollectionState {
  const page = toInt(sp.page, 1);
  const perPageRaw = toInt(sp.perPage, DEFAULT_PER_PAGE);
  const perPage = Math.min(Math.max(1, perPageRaw), PER_PAGE_CAP);

  let sort: CollectionState["sort"];
  const sortKey = sp.sort;
  if (sortKey && opts.sortableKeys.has(sortKey)) {
    sort = { field: sortKey, dir: sp.dir === "asc" ? "asc" : "desc" };
  }

  const status: StatusFilter =
    sp.status === "draft" || sp.status === "published" ? sp.status : "all";

  const selects: Record<string, string> = {};
  for (const f of opts.selectFields) {
    const raw = sp[`f_${f.key}`];
    if (raw && (f.options ?? []).includes(raw)) selects[f.key] = raw;
  }

  const search = (sp.q ?? "").slice(0, 100);

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
  if (state.status !== "all") filter.status = state.status;
  for (const [key, value] of Object.entries(state.selects)) filter[key] = value;
  if (state.search && state.searchField) {
    filter[state.searchField] = { contains: state.search };
  }
  return filter;
}
