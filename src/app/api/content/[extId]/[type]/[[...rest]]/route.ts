import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { declarativeExtensions } from "@/lib/schema";
import { authenticateApiToken } from "@/lib/api-token";
import {
  cachedPublicGetBySlug,
  cachedPublicQuery,
} from "@/ext/dx/content-cache";
import { isSubmissionTypeName } from "@/ext/dx/submission";
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

/**
 * 對外回傳形狀:不含 status(恆為 published)、不含 type。
 *
 * migrations/0011 起帶上 locale 與 translationGroup —— 雙語站的呼叫端必須能分辨
 * 「這筆是哪個語言」以及「它的其他語言版本在哪」,否則兩個譯本在回應裡長得一模一樣。
 * 舊 provider 沒填就不輸出該欄(維持既有回應形狀)。
 */
function serialize(entry: ContentEntry) {
  return {
    id: entry.id,
    slug: entry.slug,
    ...(entry.locale ? { locale: entry.locale } : {}),
    ...(entry.translationGroup
      ? { translationGroup: entry.translationGroup }
      : {}),
    data: entry.data,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * `?locale=` / `?fallback=` 的**名稱保留**(CORE_API 1.20.0)。
 *
 * 目前只做解析與驗證,不改變回傳結果 —— 完整的 fallback 鏈(請求語言 → 站台預設
 * → 404、以及 translation_group 跨 slug 查找)屬於路由層語意,排在 UI 那批一起做。
 * 現在就把名字釘下來的理由:**命名是契約,行為是實作**。等呼叫端開始用別的參數名
 * (?lang=、?l=)再改就是破壞性變更;先佔住名字則之後補上行為是純附加。
 *
 * 非法值(空字串、過長、含控制字元)一律當作未指定,不回 400 —— 與本路由既有的
 * 「未宣告 filter 欄位一律忽略」的寬容語意一致(§6.4)。
 */
function parseLocaleParams(sp: URLSearchParams): {
  locale: string | null;
  fallback: boolean;
} {
  const raw = sp.get("locale");
  const locale =
    raw && raw.length > 0 && raw.length <= 35 && /^[A-Za-z0-9-]+$/.test(raw)
      ? raw
      : null;
  // 預設開啟:單筆查詢在缺該語言版本時退回站台預設語言,好過每個未翻譯連結都 404。
  // `?fallback=0`(或 false / no)明確關閉。
  const f = sp.get("fallback");
  const fallback = !(f === "0" || f === "false" || f === "no");
  return { locale, fallback };
}

interface StoredManifest {
  contentTypes?: Array<{
    name?: string;
    fields?: Array<{ key?: string }>;
    // 收件匣判定用(見下方 isSubmissionTypeName):這兩個欄位與 publicRoutes 一起
    // 餵給 dx/submission.ts 的最小結構型別,故此處刻意保持鬆散、不引 zod 型別。
    public?: boolean;
    kind?: string;
  }>;
  publicRoutes?: Array<{ view?: string; contentType?: string }>;
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

  // locale 與 status 一樣是強制注入的 row 欄位:不經 filter.* 白名單(那條路只認
  // manifest 宣告的內容欄位),而是由 ?locale= 直接指定。未指定 = 不限語言(舊行為)。
  const { locale } = parseLocaleParams(sp);
  if (locale) filter.locale = locale;

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

  // 收件匣型別**永不**經由公開 Content API 外露 —— 在任何查詢之前就擋掉,連
  // 「存在但沒有 published 列」這種可探測的差異都不留(與未宣告的 type 同樣回 404)。
  // 判定與 interpret / admin 共用同一份實作(見 src/ext/dx/submission.ts),兩邊的
  // 認知不可能分叉;這是本功能最重要的正確性需求:外洩一封客戶詢問是隱私事故。
  // 注意這**不是**唯一防線,只是第三層:submission 列的 status 恆為 'draft',而下面
  // 的查詢一律強制 filter.status='published',所以即使這裡被拿掉也讀不到內容。
  if (isSubmissionTypeName(manifest, typeName)) return notFound();

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
