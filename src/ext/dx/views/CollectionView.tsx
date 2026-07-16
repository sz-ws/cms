import { getContentProvider, toTypeDef } from "../runtime";
import type {
  DeclarativeContentType,
  DeclarativeField,
  ListLayout,
} from "../manifest";
import { displayValue, fieldLabel, isSortable, selectColumns } from "./field-utils";
import { renderCell } from "./collection/cell-renderers";
import { parseState, toFilter } from "./collection/params";
import {
  CollectionTable,
  type ColumnMeta,
  type RowData,
} from "./collection/CollectionTable";
import {
  CollectionGrid,
  type GridCard,
} from "./collection/CollectionGrid";
import { CollectionStackedList } from "./collection/CollectionStackedList";
import { inferCardConfig } from "./collection/card-config";
import { CollectionToolbar } from "./collection/CollectionToolbar";
import { CollectionPagination } from "./collection/CollectionPagination";
import { CollectionHeader } from "./collection/CollectionHeader";
import { EmptyState } from "./collection/EmptyState";

// core-v2 §3.3:generic admin collection view。分頁·排序·filter 全部住在 URL
// searchParams;此 server component 讀取後餵給 provider.query(),互動控制件(toolbar /
// header sort / pagination / bulk bar)只改 searchParams 或呼叫 CRUD API 後 router.refresh()。

export interface CollectionViewProps {
  extId: string;
  title: string;
  adminSlug: string; // "" = 主頁
  contentType: DeclarativeContentType;
  searchParams: Record<string, string>;
  layout?: ListLayout; // §3.5 缺省 → "table"
}

export async function CollectionView({
  extId,
  title,
  adminSlug,
  contentType,
  searchParams,
  layout = "table",
}: CollectionViewProps) {
  const def = toTypeDef(extId, contentType);
  const fields = contentType.fields;
  const typeLabel = contentType.label ?? contentType.name;

  // ---- 欄位規劃 ----
  const columns = selectColumns(fields, contentType.slugField);
  const columnMeta: ColumnMeta[] = columns.map((f) => ({
    key: f.key,
    label: fieldLabel(f),
    sortable: isSortable(f),
    align: f.type === "number" ? "right" : "left",
  }));
  const sortableKeys = new Set<string>(
    columns.filter(isSortable).map((f) => f.key),
  );

  // filter 控制:每個 select 欄位一個下拉;主 text 欄位提供 contains 搜尋。
  const selectFields = fields.filter(
    (f): f is DeclarativeField & { options: string[] } =>
      f.type === "select" && Array.isArray(f.options),
  );
  const searchFieldDef =
    fields.find((f) => f.key === contentType.slugField && f.type === "text") ??
    fields.find((f) => f.type === "text");

  // ---- URL state → query ----
  const state = parseState(searchParams, {
    selectFields,
    searchField: searchFieldDef?.key,
    sortableKeys,
  });
  const filter = toFilter(state);
  const provider = await getContentProvider();
  const { items, total } = await provider.query(def.type, {
    filter,
    sort: state.sort ?? { field: "updatedAt", dir: "desc" },
    page: state.page,
    perPage: state.perPage,
  });

  const base = `/admin/ext/${extId}${adminSlug ? `/${adminSlug}` : ""}`;
  const editHref = (id?: string) =>
    `${base}/edit${id ? `?id=${encodeURIComponent(id)}` : ""}`;

  const hasFilters =
    state.status !== "all" ||
    Object.keys(state.selects).length > 0 ||
    state.search.length > 0;

  const isGrid = layout === "grid";
  const isStacked = layout === "stacked";

  // table/stacked 列共用同一批 cell 渲染(僅 grid 卡片走不同資料形狀)。
  const rows: RowData[] = isGrid
    ? []
    : items.map((entry) => ({
        id: entry.id,
        status: entry.status,
        editHref: editHref(entry.id),
        cells: columns.map((f) => renderCell(f, entry.data[f.key])),
      }));

  // grid 卡片(§3.5 推斷 cover/title/meta)。
  const card = inferCardConfig(fields, contentType.slugField);
  const metaField = card.metaField;
  const cards: GridCard[] = isGrid
    ? items.map((entry) => {
        const cover = card.coverKey ? entry.data[card.coverKey] : undefined;
        const titleRaw = card.titleKey ? entry.data[card.titleKey] : undefined;
        return {
          id: entry.id,
          status: entry.status,
          editHref: editHref(entry.id),
          title: typeof titleRaw === "string" ? titleRaw : "",
          coverKey:
            typeof cover === "string" && cover.length > 0 ? cover : null,
          meta: metaField
            ? displayValue(metaField, entry.data[metaField.key])
            : "",
        };
      })
    : [];

  return (
    <div className="flex flex-col gap-5">
      <CollectionHeader
        title={title}
        typeLabel={typeLabel}
        total={total}
        createHref={editHref()}
      />

      <CollectionToolbar
        status={state.status}
        selects={selectFields.map((f) => ({
          key: f.key,
          label: fieldLabel(f),
          options: f.options,
          value: state.selects[f.key] ?? "",
        }))}
        searchField={
          searchFieldDef
            ? { key: searchFieldDef.key, label: fieldLabel(searchFieldDef) }
            : undefined
        }
        search={state.search}
      />

      {total === 0 ? (
        <EmptyState
          typeLabel={typeLabel}
          createHref={editHref()}
          filtered={hasFilters}
          clearHref={base}
        />
      ) : (
        <>
          {isGrid ? (
            <CollectionGrid
              extId={extId}
              typeName={contentType.name}
              cards={cards}
            />
          ) : isStacked ? (
            <CollectionStackedList columns={columnMeta} rows={rows} />
          ) : (
            <CollectionTable
              extId={extId}
              typeName={contentType.name}
              columns={columnMeta}
              rows={rows}
              activeSort={state.sort}
            />
          )}
          <CollectionPagination
            page={state.page}
            perPage={state.perPage}
            total={total}
            count={items.length}
          />
        </>
      )}
    </div>
  );
}
