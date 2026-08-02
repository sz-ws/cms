import * as React from "react";
import {
  OG_FONT_FAMILY,
  OG_FONT_WEIGHTS,
  collectText,
} from "@/components/og/subset-text";
import { getExtRuntime } from "@/ext/loader";
import { getContentProvider, toTypeDef } from "@/ext/dx/runtime";
import type { DeclarativeContentType } from "@/ext/dx/manifest";
import { getOgTemplate } from "@/components/og/templates";
// ⚠️ 不要加回 `export const runtime = "edge"`。
//
// 它原本寫著「刻意用 edge runtime,避免 OG template 查找拉進 Node 側的
// Drizzle/loader」—— 但這個部署目標是 Cloudflare Workers + OpenNext,**整個 app
// 本來就跑在 workerd**,沒有「Node 側」可以避開,所以那個好處不存在。
//
// 代價卻是真的:@opennextjs/aws 的 copyTracedFiles 要求 edge runtime 的函式必須
// 被拆成獨立 bundle,遇到宣告 edge 的 app router route 會直接讓整個 build 失敗:
//
//   Error: app/api/og/[extId]/[type]/[slug]/route cannot use the edge runtime.
//          OpenNext requires edge runtime function to be defined in a separate function.

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
  // ⚠️ 動態 import,不可以改成頂層 import。
  //
  // workers-og 以 `import x from "./x.wasm"` 載入 yoga / resvg,而 Next 在
  // build 的 "collecting page data" 階段會**在 Node 裡實際載入這個 route 模組** ——
  // Node 解析不了那個 .wasm,整個 build 會失敗:
  //
  //   Error: Cannot find package 'a' imported from .../yoga-ZMNYPE6Z.wasm
  //   Error: Failed to collect page data for /api/og/[extId]/[type]/[slug]
  //
  // 放進 handler 之後,那段程式碼只在真的有請求時才求值 —— 那時已經在 workerd 上,
  // wasm 模組 import 是原生支援的。
  const { ImageResponse, loadGoogleFont } = await import("workers-og");
  return new ImageResponse(React.createElement(Component, props), {
    width: 1200,
    height: 630,
    fonts: await ogFonts(collectText(props), loadGoogleFont),
  });
}

// ---- 字型 ------------------------------------------------------------------
//
// ⚠️ 這個 route 用 `workers-og` 而**不是** `next/og`,兩者的 satori 引擎相同,
// 差別在 wasm 的載入方式:next/og 在執行期 `WebAssembly.compile()` 一段 bytes,
// 而 Cloudflare Workers **禁止**執行期從 bytes 編譯 wasm ——
//
//   CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder
//
// workers-og 把 yoga / resvg 以 `import x from "./x.wasm"` 靜態載入,那是 Workers
// 接受的形式。它的 ImageResponse 同樣收 React element(`string | React.ReactNode`),
// 所以 src/components/og/ 的 16 個模板一行都不用改。
//
// ## 為什麼一定要自己給字型
//
// 不給的話 satori 只有內建的拉丁字型,**中日韓字元會全部變成豆腐塊,而且不會報錯** ——
// 產出的圖看起來「成功」,只是每個字都是方框。本專案的 i18n 預設是 zh-Hant,
// 所以這不是邊緣情況,是主要情況。
//
// ## 為什麼只抓 400 與 700
//
// 模板實際用到 500/600/700/800 四種字重,但每個字重都是一次獨立的網路抓取。
// satori 會把要求的字重對應到最接近的可用者,而 OG 圖是裝飾性的 ——
// 600 落到 700、500 落到 400,視覺差異遠小於多兩次往返的成本。

/**
 * 抓字型子集。**失敗時回空陣列而不是 throw** —— 拿不到字型的結果是拉丁字正常、
 * CJK 變豆腐塊,那仍然比「整張圖產不出來、分享時完全沒有預覽」好。失敗會留在
 * log 裡(這是唯一會知道的途徑,因為產出的圖看起來是成功的)。
 */
async function ogFonts(
  text: string,
  loadGoogleFont: (o: { family: string; weight: number; text: string }) => Promise<ArrayBuffer>,
) {
  const wanted = text.trim() || OG_FONT_FAMILY; // 空字串會讓 Google 回 400
  const results = await Promise.all(
    OG_FONT_WEIGHTS.map(async (weight) => {
      try {
        const data = await loadGoogleFont({ family: OG_FONT_FAMILY, weight, text: wanted });
        return { name: OG_FONT_FAMILY, data, weight, style: "normal" as const };
      } catch (e) {
        console.error(`[og] font ${OG_FONT_FAMILY}@${weight} failed`, e);
        return null;
      }
    }),
  );
  return results.filter((f): f is NonNullable<typeof f> => f !== null);
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
