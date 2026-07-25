import * as React from "react";
import { ImageResponse } from "next/og";
import { getExtRuntime } from "@/ext/loader";
import { getContentProvider, toTypeDef } from "@/ext/dx/runtime";
import type { DeclarativeContentType } from "@/ext/dx/manifest";
import { getOgTemplate } from "@/components/og/templates";
// Note: this route is intentionally edge-runtime so the OG template lookup
// doesn't pull the full Node-side Drizzle/loader paths.

// Generic OG image endpoint driven by declarative extensions.
//
// URL: /api/og/<extId>/<type>/<slug>
//   - requires the extension to be enabled
//   - requires contentType <type> to have public route(s)
//   - requires manifest.og.image.template (e.g. "blog", "changelog", ...)
//   - resolved at runtime via dynamic import; missing templates return 404
//
// The dynamic import is keyed by the OG template name declared in the manifest
// so extensions stay decoupled — they only need to know the slug, not the
// build path of the component.

export const runtime = "edge";
interface RouteParams {
  params: Promise<{ extId: string; type: string; slug: string }>;
}

function pickField<T = unknown>(
  data: Record<string, unknown>,
  fields: { key: string }[],
  names: string[],
): T | undefined {
  for (const name of names) {
    const f = fields.find((f) => f.key === name);
    if (!f) continue;
    const v = data[f.key];
    if (v === undefined || v === null || v === "") continue;
    return v as T;
  }
  return undefined;
}

function text(data: Record<string, unknown>, fields: { key: string }[], names: string[], fallback: string) {
  const v = pickField<string>(data, fields, names);
  return v && v.trim() ? v : fallback;
}

function dateText(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return new Date().toISOString().slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function metaText(data: Record<string, unknown>, fields: { key: string }[]) {
  const author = pickField<string>(data, fields, ["author", "byline"]);
  const publishedAt = pickField<number>(data, fields, ["publishedAt", "date"]);
  const category = pickField<string>(data, fields, ["category", "kind"]);
  const parts: string[] = [];
  if (author) parts.push(author);
  if (publishedAt) parts.push(dateText(publishedAt));
  else if (category) parts.push(category);
  return parts.join(" · ");
}

function categoryText(
  data: Record<string, unknown>,
  fields: { key: string }[],
) {
  const v = pickField<string>(data, fields, ["category", "kind", "type"]);
  if (v) return v.toUpperCase();
  return "ARTICLE";
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { extId, type, slug } = await params;
  const rt = await getExtRuntime();
  const ext = rt.byId(extId);
  if (!ext) return new Response("Not found", { status: 404 });
  const og = ext.og?.image;
  if (!og?.template) return new Response("No OG image configured", { status: 404 });

  const ct: DeclarativeContentType | undefined =
    (ext.contentTypes ?? []).find((c) => c.name === type);
  if (!ct) return new Response("Content type not found", { status: 404 });

  const provider = await getContentProvider();
  const def = toTypeDef(extId, ct);
  const entry = await provider.getBySlug(def.type, slug);
  if (!entry) return new Response("Not found", { status: 404 });

  const data = entry.data as Record<string, unknown>;
  const fields = ct.fields;

  const component = getOgTemplate(og.template);
  if (!component) {
    return new Response("Unknown OG template", { status: 404 });
  }

  const brand = og.brand ?? "";
  const fallbackTitle = slug.replace(/[-_]/g, " ");

  const props: Record<string, unknown> = {};
  switch (og.template) {
    case "blog":
      Object.assign(props, {
        category: categoryText(data, fields),
        title: text(data, fields, ["title", "name", "headline"], fallbackTitle),
        excerpt: text(data, fields, ["excerpt", "summary", "description"], ""),
        author: text(data, fields, ["author", "byline"], "Unknown"),
        meta: metaText(data, fields),
        avatar: pickField<string>(data, fields, ["avatar", "cover"]) ?? undefined,
        brand,
      });
      break;
    case "changelog":
      Object.assign(props, {
        version: pickField<string>(data, fields, ["version"]) ?? "v0.0.0",
        date: dateText(pickField<number>(data, fields, ["date"]) ?? Date.now()),
        title: text(data, fields, ["title", "name"], fallbackTitle),
        items: pickStringArray(data, fields, ["items", "highlights", "changes"]),
        brand,
      });
      break;
    case "event":
      Object.assign(props, {
        title: text(data, fields, ["title", "name"], fallbackTitle),
        date: dateText(pickField<number>(data, fields, ["date", "startsAt"]) ?? Date.now()),
        location: text(data, fields, ["location", "venue"], "Online"),
        description: text(data, fields, ["description", "summary"], ""),
        brand,
      });
      break;
    case "product":
      Object.assign(props, {
        title: text(data, fields, ["title", "name"], fallbackTitle),
        price: pickField<string | number>(data, fields, ["price"]) ?? "—",
        tagline: text(data, fields, ["tagline", "summary", "description"], ""),
        brand,
      });
      break;
    case "stat":
      Object.assign(props, {
        label: text(data, fields, ["label", "title"], "Metric"),
        value: pickField<string | number>(data, fields, ["value", "amount"]) ?? "0",
        change: pickField<string>(data, fields, ["change", "delta"]) ?? undefined,
        brand,
      });
      break;
    case "quote":
      Object.assign(props, {
        quote: text(data, fields, ["quote", "body", "excerpt"], ""),
        author: text(data, fields, ["author", "name"], "Anon"),
        brand,
      });
      break;
    case "showcase":
      Object.assign(props, {
        title: text(data, fields, ["title", "name"], fallbackTitle),
        description: text(data, fields, ["description", "summary"], ""),
        brand,
      });
      break;
    default: {
      const v = pickField<string>(data, fields, ["title", "name"]) ?? fallbackTitle;
      const b = pickField<string>(data, fields, ["body", "description", "summary"]) ?? "";
      Object.assign(props, {
        title: v,
        body: b,
        brand,
        slug,
      });
    }
  }

  const Component = component as unknown as React.ComponentType<Record<string, unknown>>;
  return new ImageResponse(
    React.createElement(Component, props),
    {
      width: 1200,
      height: 630,
    },
  );
}

function pickStringArray(
  data: Record<string, unknown>,
  fields: { key: string }[],
  names: string[],
): string[] {
  for (const name of names) {
    const f = fields.find((f) => f.key === name);
    if (!f) continue;
    const v = data[f.key];
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}
