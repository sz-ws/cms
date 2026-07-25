import type { ReactNode } from "react";
import type { DeclarativeField, DeclarativeLeafField } from "../manifest";
import { blockLabel, displayValue, fieldLabel } from "./field-utils";
import { renderRichtext } from "./richtext-render";
import { isMediaKey } from "../media-key";
import { MediaImage } from "@/components/ui/media-image";
import { NO_MEDIA_DIMS, type MediaDims } from "./media-dims";
import type { Locale } from "@/lib/i18n/index";

// Tier 2 v1.2: readable server-side rendering of structural field values on the
// public DetailView. Pure (no I/O, no hooks) so it stays in the server render
// path alongside the rest of DetailView.
//
// group   → a nested definition list of its leaf subfields.
// repeater→ an ordered list; each row a nested definition list.
// blocks  → an ordered list; each block shows its type label + a nested list.
//
// One level of nesting only (v1): subfields are always leaf types, so each
// subfield renders via the same leaf primitives DetailView already uses
// (richtext → renderRichtext, media → <img>, everything else → displayValue).

/** Render one leaf subfield's value (richtext / media / scalar). */
function renderLeaf(
  field: DeclarativeLeafField,
  value: unknown,
  dims: MediaDims,
): ReactNode {
  if (value === undefined || value === null || value === "") return null;
  if (field.type === "richtext") {
    return (
      <div className="richtext-content flex flex-col gap-2 [&_a]:text-indigo-600 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-600 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6">
        {renderRichtext(value)}
      </div>
    );
  }
  if (field.type === "media") {
    // Phase E §2: render-time allowlist guard (mirrors DetailView's top-level
    // media rendering and richtext-render's image src check) — refuse to
    // emit an <img src> for anything that doesn't pass isMediaKey.
    const key = String(value);
    if (!isMediaKey(key)) return null;
    // 巢狀欄位在 DetailView 的 max-w-2xl 版心內,實際版位約 640px;srcset 的
    // 上限就給 640,免得高 DPR 螢幕去抓 1920w 的檔。
    const d = dims.get(key);
    return (
      <MediaImage
        mediaKey={key}
        alt=""
        maxWidth={640}
        sizes="(max-width: 672px) 100vw, 640px"
        width={d?.width}
        height={d?.height}
        className="max-w-full rounded"
      />
    );
  }
  return <span>{displayValue(field, value)}</span>;
}

/** A nested definition list of leaf subfields for one object of values. */
function LeafList({
  fields,
  data,
  locale,
  dims,
}: {
  fields: readonly DeclarativeLeafField[];
  data: Record<string, unknown>;
  locale: Locale;
  dims: MediaDims;
}) {
  return (
    <dl className="flex flex-col gap-2">
      {fields.map((sf) => {
        const node = renderLeaf(sf, data[sf.key], dims);
        if (node === null) return null;
        return (
          <div key={sf.key} className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">
              {fieldLabel(sf, locale)}
            </dt>
            <dd className="text-sm text-gray-800">{node}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asObjectArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (el): el is Record<string, unknown> =>
          el !== null && typeof el === "object" && !Array.isArray(el),
      )
    : [];
}

/**
 * Render a structural field (group / repeater / blocks) value for DetailView.
 * Returns null when there's nothing to show.
 */
export function renderStructural(
  field: DeclarativeField,
  value: unknown,
  locale: Locale,
  // 預設空 map:呼叫端沒帶尺寸時,<img> 就不放 width/height,行為同 1.19 之前。
  dims: MediaDims = NO_MEDIA_DIMS,
): ReactNode {
  if (field.type === "group") {
    const fields = field.fields ?? [];
    const data = asObject(value);
    if (Object.keys(data).length === 0) return null;
    return (
      <div className="rounded-xl bg-gray-50 p-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]">
        <LeafList fields={fields} data={data} locale={locale} dims={dims} />
      </div>
    );
  }

  if (field.type === "repeater") {
    const fields = field.fields ?? [];
    const rows = asObjectArray(value);
    if (rows.length === 0) return null;
    return (
      <ol className="flex flex-col gap-3">
        {rows.map((row, i) => (
          <li
            key={i}
            className="rounded-xl bg-gray-50 p-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]"
          >
            <LeafList fields={fields} data={row} locale={locale} dims={dims} />
          </li>
        ))}
      </ol>
    );
  }

  if (field.type === "blocks") {
    const defs = field.blocks ?? [];
    const byName = new Map(defs.map((b) => [b.name, b]));
    const items = asObjectArray(value);
    if (items.length === 0) return null;
    return (
      <ol className="flex flex-col gap-3">
        {items.map((item, i) => {
          const name = typeof item["block"] === "string" ? item["block"] : "";
          const def = byName.get(name);
          return (
            <li
              key={i}
              className="rounded-xl bg-gray-50 p-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]"
            >
              <span className="mb-2 inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
                {def ? blockLabel(def, locale) : name || "unknown"}
              </span>
              {def ? (
                <LeafList fields={def.fields} data={item} locale={locale} dims={dims} />
              ) : (
                <p className="text-sm text-gray-400">Unknown block type.</p>
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return null;
}
