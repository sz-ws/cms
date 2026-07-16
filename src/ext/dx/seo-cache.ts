import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents, declarativeExtensions as dxTable } from "@/lib/schema";
import { getSetting } from "@/lib/settings";
import { parseManifest } from "./manifest";
import type { DeclarativeField } from "./manifest";
import { displayValue, pickTitleField } from "./views/field-utils";

// SEO 基礎(robots.txt / sitemap.xml / feed.xml)共用的 isolate 內 TTL cache。
// 三個公開端點都經 getSeoSnapshot() 讀資料:settings(core.seo.* / core.siteUrl /
// core.siteTitle / core.siteDescription)+ declarative manifest 掃描(哪些 content
// type 有 detail/list public route)+ 一次 bounded `contents` 查詢,全部包進同一份
// snapshot。TTL(5 分鐘)內重複呼叫 = 直接回傳快取物件,零 settings 讀、零 contents
// 查詢——照 src/lib/oidc.ts 的 discoveryCache precedent(isolate 內 Map + at 時戳,
// 非 next/cache,worker isolate 存活期間有效)。
//
// 為何直查 `contents` 而不是走 CoreContentProvider.query():provider.query() 的
// perPage 上限是 100(單一 content type 分頁用),sitemap 需要「跨多個 content type
// 聚合」且上限 5000——用一次 `type IN (...)` + LIMIT 5000 + ORDER BY updatedAt DESC
// 的 SQL 查詢達成,RSS 的「最近 50 筆」直接從這份已排序結果切前 50 筆,不必再查一次。

const TTL_MS = 5 * 60 * 1000;
const SITEMAP_MAX = 5000;
const FEED_MAX = 50;

export interface SitemapUrl {
  /** 站內相對路徑(含開頭 "/")。絕對化交給呼叫端(resolveSiteOrigin)。 */
  path: string;
  lastModified: number; // epoch ms
}

export interface FeedItem {
  title: string;
  path: string;
  pubDate: number; // epoch ms(publishAt ?? updatedAt)
}

export interface SeoSnapshot {
  robotsEnabled: boolean;
  sitemapEnabled: boolean;
  rssEnabled: boolean;
  siteUrl: string;
  siteTitle: string;
  siteDescription: string;
  sitemapUrls: SitemapUrl[];
  feedItems: FeedItem[];
}

interface DetailRouteInfo {
  type: string; // "<extId>.<typeName>"
  base: string; // detail pattern with the trailing :slug segment dropped
  titleField?: DeclarativeField;
}

/** pattern 字串(如 "/gallery/:slug")→ 段陣列,並回報是否含 param 段。 */
function splitPattern(pattern: string): { parts: string[]; hasParam: boolean } {
  const parts = pattern.split("/").filter((s) => s.length > 0);
  return { parts, hasParam: parts.some((s) => s.startsWith(":")) };
}

/**
 * 掃描所有 enabled declarative extension 的 manifest,收集:
 *   - detail route → per-type base path(trailing :slug 段去掉,同 relation-resolve.ts
 *     的 detailBase() 邏輯)+ 標題欄(pickTitleField)。
 *   - list route → 直接可列的靜態路徑(含 param 的 pattern 略過——sitemap 不猜值)。
 */
async function buildRouteIndex(): Promise<{
  detailRoutes: DetailRouteInfo[];
  listPaths: string[];
}> {
  const rows = await db()
    .select({ id: dxTable.id, manifest: dxTable.manifest })
    .from(dxTable)
    .where(eq(dxTable.enabled, 1));

  const detailRoutes: DetailRouteInfo[] = [];
  const listPaths: string[] = [];

  for (const row of rows) {
    let json: unknown;
    try {
      json = JSON.parse(row.manifest);
    } catch {
      continue; // §5 精神:壞資料跳過,不讓 SEO 端點連累其他 extension。
    }
    const parsed = parseManifest(json);
    if (!parsed.ok || !parsed.manifest) continue;
    const manifest = parsed.manifest;
    const typesByName = new Map(
      (manifest.contentTypes ?? []).map((ct) => [ct.name, ct] as const),
    );

    for (const pr of manifest.publicRoutes ?? []) {
      const { parts, hasParam } = splitPattern(pr.pattern);
      if (pr.view === "list") {
        if (!hasParam) listPaths.push(`/${parts.join("/")}`);
        continue;
      }
      if (pr.view !== "detail") continue;
      const ct = typesByName.get(pr.contentType);
      if (!ct) continue;
      parts.pop(); // 去掉尾端 :slug 段
      detailRoutes.push({
        type: `${row.id}.${ct.name}`,
        base: `/${parts.join("/")}`,
        titleField: pickTitleField(ct.fields, ct.slugField),
      });
    }
  }
  return { detailRoutes, listPaths };
}

async function computeSnapshot(): Promise<SeoSnapshot> {
  const [robotsEnabled, sitemapEnabled, rssEnabled, siteUrl, siteTitle, siteDescription] =
    await Promise.all([
      getSetting<boolean>("core.seo.robots", true),
      getSetting<boolean>("core.seo.sitemap", true),
      getSetting<boolean>("core.seo.rss", true),
      getSetting<string>("core.siteUrl", ""),
      getSetting<string>("core.siteTitle", "My Site"),
      getSetting<string>("core.siteDescription", ""),
    ]);

  const { detailRoutes, listPaths } = await buildRouteIndex();
  const byType = new Map(detailRoutes.map((r) => [r.type, r] as const));
  const types = [...byType.keys()];

  const rows =
    types.length === 0
      ? []
      : await db()
          .select({
            type: contents.type,
            slug: contents.slug,
            data: contents.data,
            publishAt: contents.publishAt,
            updatedAt: contents.updatedAt,
          })
          .from(contents)
          .where(and(inArray(contents.type, types), eq(contents.status, "published")))
          .orderBy(desc(contents.updatedAt))
          .limit(SITEMAP_MAX);

  const sitemapUrls: SitemapUrl[] = [];
  const feedItems: FeedItem[] = [];

  for (const row of rows) {
    if (!row.slug) continue;
    const info = byType.get(row.type);
    if (!info) continue;
    const path = `${info.base}/${row.slug}`;
    sitemapUrls.push({ path, lastModified: row.updatedAt });

    if (feedItems.length < FEED_MAX) {
      let data: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.data) as unknown;
        if (parsed && typeof parsed === "object")
          data = parsed as Record<string, unknown>;
      } catch {
        // 壞資料:title 落回 slug(下方 fallback)。
      }
      const title =
        (info.titleField
          ? displayValue(info.titleField, data[info.titleField.key])
          : ""
        ).trim() || row.slug;
      feedItems.push({ title, path, pubDate: row.publishAt ?? row.updatedAt });
    }
  }

  // list route 本身也進 sitemap(不含 lastModified 語意,落 now)。
  const now = Date.now();
  for (const p of listPaths) sitemapUrls.push({ path: p, lastModified: now });

  return {
    robotsEnabled,
    sitemapEnabled,
    rssEnabled,
    siteUrl,
    siteTitle,
    siteDescription,
    sitemapUrls,
    feedItems,
  };
}

let cache: { at: number; value: SeoSnapshot } | null = null;

/** robots.ts / sitemap.ts / feed.xml route 共用的入口。TTL 內回傳同一個快取物件
 * (referential equality——測試靠這點驗證「零重算」,不必額外 mock DB 呼叫計數)。 */
export async function getSeoSnapshot(): Promise<SeoSnapshot> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = await computeSnapshot();
  cache = { at: now, value };
  return value;
}

/** 測試用:清 isolate 內 SEO snapshot cache(同 oidc.ts __clearOidcCaches precedent)。 */
export function __clearSeoCache(): void {
  cache = null;
}

/**
 * 絕對 URL 的 origin:core.siteUrl 有效時優先(https/http),否則退回本次 request
 * 的 host header(next/headers,僅在有 request context 的 route 內可用)。三個 SEO
 * 端點都走這支,確保「擇一並一致」。取不到任何 origin(無 siteUrl 且測試/無 host
 * header 情境)回傳空字串,呼叫端自行決定 fallback(相對路徑)。
 */
export async function resolveSiteOrigin(siteUrl: string): Promise<string> {
  if (siteUrl) {
    try {
      const u = new URL(siteUrl);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // 忽略無效 siteUrl,退回 request host。
    }
  }
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("host");
    return host ? `https://${host}` : "";
  } catch {
    return ""; // 無 request context(如非 route 環境的單元測試)。
  }
}
