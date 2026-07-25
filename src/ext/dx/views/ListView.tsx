import Link from "next/link";
import { toTypeDef } from "../runtime";
import { cachedPublicQuery } from "../content-cache";
import type { DeclarativeContentType, ListLayout } from "../manifest";
import { displayValue } from "./field-utils";
import { inferCardConfig } from "./collection/card-config";
import { StackedList, StackedListItem } from "@/components/ui/stacked-list";
import { MediaImage } from "@/components/ui/media-image";
import { getLocale } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// core-v2 §3.3/§3.5:generic public list view。列出某 content type 的 published
// entry。layout:"table"(預設,單列連結)、"grid"(響應式卡片格,cover/title/meta)或
// "stacked"(vendored StackedList/StackedListItem sweep-in 動效,同 ExtRecentCard)。
// 三種模式共用 provider.query 結果;grid/stacked 的 card/row anatomy 由 field defs
// 推斷(§3.5,inferCardConfig)。

const PUBLIC_PAGE_SIZE = 20;

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"]);

function isImageKey(key: string): boolean {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export interface ListViewProps {
  extId: string;
  contentType: DeclarativeContentType;
  detailBase: string | null; // detail route 前綴(如 "/gallery");無 detail route 則 null
  layout?: ListLayout; // §3.5 缺省 → "table"
}

export async function ListView({
  extId,
  contentType,
  detailBase,
  layout = "table",
}: ListViewProps) {
  const def = toTypeDef(extId, contentType);
  // public 匿名讀取:走 tagged data cache(content:<type> / ext:<extId>),mutation 精準失效。
  const { items } = await cachedPublicQuery(extId, def.type, {
    filter: { status: "published" },
    sort: { field: "createdAt", dir: "desc" },
    page: 1,
    perPage: PUBLIC_PAGE_SIZE,
  });

  const titleField =
    contentType.fields.find((f) => f.key === contentType.slugField) ??
    contentType.fields[0];

  const hrefFor = (slug: string | null): string | null =>
    detailBase && slug ? `${detailBase}/${slug}` : null;

  const locale = await getLocale();
  const heading =
    resolveLocalizedString(contentType.label, locale) ?? contentType.name;
  const isGrid = layout === "grid";
  const isStacked = layout === "stacked";

  return (
    <main
      className={
        isGrid
          ? "mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12"
          : "mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12"
      }
    >
      <h1 className="text-3xl font-semibold text-gray-900">{heading}</h1>

      {items.length === 0 ? (
        <p className="text-gray-500">Nothing published yet.</p>
      ) : isGrid ? (
        <GridBody
          items={items}
          contentType={contentType}
          hrefFor={hrefFor}
        />
      ) : isStacked ? (
        <StackedBody
          items={items}
          contentType={contentType}
          hrefFor={hrefFor}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((entry) => {
            const label =
              displayValue(titleField, entry.data[titleField.key]) || entry.id;
            const href = hrefFor(entry.slug);
            return (
              <li key={entry.id} className="flex flex-col gap-1">
                {href ? (
                  <Link
                    href={href}
                    // 1.8.0:accent token tint(fallback 為現行 indigo-600)。
                    style={{ color: "var(--ext-accent, #4f46e5)" }}
                    className="text-lg font-medium hover:underline"
                  >
                    {label}
                  </Link>
                ) : (
                  <span className="text-lg font-medium text-gray-900">
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

// ---- grid body(§3.5 卡片格,cover/title/meta 推斷)----

interface GridEntry {
  id: string;
  slug: string | null;
  data: Record<string, unknown>;
}

function GridBody({
  items,
  contentType,
  hrefFor,
}: {
  items: GridEntry[];
  contentType: DeclarativeContentType;
  hrefFor: (slug: string | null) => string | null;
}) {
  const card = inferCardConfig(contentType.fields, contentType.slugField);
  const metaField = card.metaField;

  return (
    <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((entry) => {
        const titleRaw = card.titleKey ? entry.data[card.titleKey] : undefined;
        const title = typeof titleRaw === "string" ? titleRaw : entry.id;
        const coverRaw = card.coverKey ? entry.data[card.coverKey] : undefined;
        const coverKey =
          typeof coverRaw === "string" && coverRaw.length > 0 ? coverRaw : null;
        const meta = metaField
          ? displayValue(metaField, entry.data[metaField.key])
          : "";
        const href = hrefFor(entry.slug);

        const inner = (
          <>
            {coverKey && isImageKey(coverKey) ? (
              // 公開卡:image outline(純黑低透明),8px 圓角坐落 12px 卡 - pad 內。
              // aspect box 已鎖住版位,不需要 width/height 屬性;srcset 只為省頻寬
              // ——— 卡片最寬約 1 欄佈局下的 640px,再高的刻度用不到。
              <MediaImage
                mediaKey={coverKey}
                alt=""
                maxWidth={640}
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 320px"
                className="aspect-[4/3] w-full rounded-[8px] object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]"
              />
            ) : (
              <div className="flex aspect-[4/3] w-full items-center justify-center rounded-[8px] bg-black/[0.03] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]">
                <span className="text-[28px] font-semibold text-black/15">
                  {title.trim().charAt(0).toUpperCase() || "—"}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-1 px-1 pb-1">
              <span className="text-[15px] font-medium leading-snug text-gray-900">
                {title}
              </span>
              {meta && (
                <span className="text-[13px] tabular-nums text-gray-500">
                  {meta}
                </span>
              )}
            </div>
          </>
        );

        return (
          <li key={entry.id}>
            {href ? (
              <Link
                href={href}
                // 1.8.0:card radius token(fallback 為現行 12px)。
                style={{ borderRadius: "var(--ext-radius, 12px)" }}
                className="flex flex-col gap-3 bg-white p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] transition-[transform,box-shadow] duration-150 ease-out will-change-transform hover:-translate-y-0.5 hover:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_28px_-10px_rgba(30,20,50,0.18)]"
              >
                {inner}
              </Link>
            ) : (
              <div
                style={{ borderRadius: "var(--ext-radius, 12px)" }}
                className="flex flex-col gap-3 bg-white p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]"
              >
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- stacked body(§3.5 vendored StackedList,標題 + meta 一行,同 ExtRecentCard)----

function StackedBody({
  items,
  contentType,
  hrefFor,
}: {
  items: GridEntry[];
  contentType: DeclarativeContentType;
  hrefFor: (slug: string | null) => string | null;
}) {
  const card = inferCardConfig(contentType.fields, contentType.slugField);
  const metaField = card.metaField;

  return (
    <div
      // 1.8.0:card radius token(fallback 為現行 14px)。
      style={{ borderRadius: "var(--ext-radius, 14px)" }}
      className="overflow-hidden bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]"
    >
      <StackedList className="divide-y divide-black/[0.05]">
        {items.map((entry) => {
          const titleRaw = card.titleKey ? entry.data[card.titleKey] : undefined;
          const title = typeof titleRaw === "string" ? titleRaw : entry.id;
          const meta = metaField
            ? displayValue(metaField, entry.data[metaField.key])
            : "";
          const href = hrefFor(entry.slug);

          const inner = (
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-gray-900">
                {title}
              </span>
              {meta && (
                <span className="shrink-0 text-[13px] tabular-nums text-gray-500">
                  {meta}
                </span>
              )}
            </div>
          );

          return (
            <StackedListItem key={entry.id}>
              {href ? (
                <Link
                  href={href}
                  className="block transition-colors duration-150 ease-out hover:bg-black/[0.02]"
                >
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </StackedListItem>
          );
        })}
      </StackedList>
    </div>
  );
}
