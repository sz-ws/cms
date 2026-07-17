import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions } from "@/lib/schema";
import { authenticateApiToken } from "@/lib/api-token";
import {
  cachedPublicGetBySlug,
  cachedPublicQuery,
} from "@/ext/dx/content-cache";
import type {
  ContentEntry,
  ContentFilterValue,
  ContentQuery,
} from "@/ext/capabilities";

// roadmap #1:Public Content API(GET only)。inbound bearer token 認證(非 cookie
// session,故「不做」Origin 檢查:bearer 本身即憑證,無 CSRF 面 —— 對比 spec 04 §5
// 只把 Origin 綁在 cookie 認證的 mutation 路由)。強制 published-only:一律注入
// filter.status="published",呼叫方無法覆寫(draft 永不外洩)。
//
// 形狀:
//   GET /api/content/<extId>/<type>          → list  { items, total, page, perPage }
//   GET /api/content/<extId>/<type>/<slug>   → detail { id, slug, data, createdAt, updatedAt }
//
// 走既有 cachedPublicQuery/cachedPublicGetBySlug tagged cache(content mutation 已會失效)。

const PER_PAGE_CAP = 100;
const DEFAULT_PER_PAGE = 20;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/** 對外回傳形狀:不含 status(恆為 published)、不含 type。 */
function serialize(entry: ContentEntry) {
  return {
    id: entry.id,
    slug: entry.slug,
    data: entry.data,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

interface StoredManifest {
  contentTypes?: Array<{ name?: string; fields?: Array<{ key?: string }> }>;
  customApiRoutes?: Array<{ contentType?: string }>;
}

/** 從 searchParams 組出 ContentQuery。status 恆被覆寫為 published(呼叫方不可控)。 */
function buildQuery(
  sp: URLSearchParams,
  fieldKeys: Set<string>,
): { query: ContentQuery; page: number; perPage: number } {
  // 強制 published-only —— 放在最後合併,呼叫方傳入的任何 status filter 都被忽略。
  const filter: Record<string, ContentFilterValue> = {};
  for (const [k, v] of sp.entries()) {
    if (!k.startsWith("filter.")) continue;
    const field = k.slice("filter.".length);
    // 白名單:只允許該 type manifest 宣告的欄位 + slug。status 永不接受(強制注入)。
    // SPEC-GAP(§6.4 二擇一):未宣告欄位「忽略」(不回 400)。
    if (!field || field === "status") continue;
    if (fieldKeys.has(field)) filter[field] = v;
  }
  filter.status = "published";

  let sort: ContentQuery["sort"];
  const sortRaw = sp.get("sort");
  if (sortRaw) {
    const [field, dir] = sortRaw.split(":");
    if (field) sort = { field, dir: dir === "asc" ? "asc" : "desc" };
  }

  const rawPerPage = Number.parseInt(sp.get("perPage") ?? "", 10);
  const perPage = Number.isFinite(rawPerPage)
    ? Math.min(Math.max(1, rawPerPage), PER_PAGE_CAP)
    : DEFAULT_PER_PAGE;
  const rawPage = Number.parseInt(sp.get("page") ?? "", 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;

  return { query: { filter, sort, page, perPage }, page, perPage };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ extId: string; type: string; rest?: string[] }> },
): Promise<Response> {
  // 1) 認證:bearer token(無 / 錯 → 401)。
  const identity = await authenticateApiToken(req);
  if (!identity) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { extId, type: typeName, rest } = await ctx.params;

  // 2) 只讀 enabled 的 declarative extension 宣告的 content types。
  const rows = await db()
    .select({ manifest: declarativeExtensions.manifest })
    .from(declarativeExtensions)
    .where(
      and(
        eq(declarativeExtensions.id, extId),
        eq(declarativeExtensions.enabled, 1),
      ),
    )
    .limit(1);
  if (!rows[0]) return notFound(); // extId 未啟用

  let manifest: StoredManifest;
  try {
    manifest = JSON.parse(rows[0].manifest) as StoredManifest;
  } catch {
    return notFound();
  }

  const contentTypes = Array.isArray(manifest.contentTypes)
    ? manifest.contentTypes
    : [];
  const ct = contentTypes.find((c) => c?.name === typeName);
  if (!ct) return notFound(); // 該 type 非其宣告

  // 3) customApiRoutes gating:宣告了 customApiRoutes → 只有列入 contentType 的 type
  //    對外開放,其餘 403 not_exposed;完全未宣告 → 全部 published type 皆可讀。
  const customApiRoutes = Array.isArray(manifest.customApiRoutes)
    ? manifest.customApiRoutes
    : [];
  if (customApiRoutes.length > 0) {
    const exposed = new Set(
      customApiRoutes
        .map((r) => r?.contentType)
        .filter((x): x is string => typeof x === "string"),
    );
    if (!exposed.has(typeName)) {
      return Response.json({ error: "not_exposed" }, { status: 403 });
    }
  }

  const fullType = `${extId}.${typeName}`;
  const fieldKeys = new Set<string>(["slug"]);
  for (const f of ct.fields ?? []) {
    if (typeof f?.key === "string") fieldKeys.add(f.key);
  }

  const segments = rest ?? [];

  // detail:GET /<extId>/<type>/<slug>(published only)。
  if (segments.length > 0) {
    if (segments.length > 1) return notFound(); // 多餘段落 → 404
    const slug = segments[0];
    const entry = await cachedPublicGetBySlug(extId, fullType, slug);
    if (!entry || entry.status !== "published") return notFound();
    return Response.json(serialize(entry));
  }

  // list:GET /<extId>/<type>。
  const sp = new URL(req.url).searchParams;
  const { query, page, perPage } = buildQuery(sp, fieldKeys);
  const { items, total } = await cachedPublicQuery(extId, fullType, query);
  return Response.json({
    items: items.map(serialize),
    total,
    page,
    perPage,
  });
}
