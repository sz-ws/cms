import type { MetadataRoute } from "next";
import { getSeoSnapshot, resolveSiteOrigin } from "@/ext/dx/seo-cache";

export const dynamic = "force-dynamic";

// SEO 基礎:core.seo.sitemap 關閉時回空陣列(等同無 sitemap)。啟用時列出每個
// enabled declarative extension 的 detail public route 已 published 的 entries
// (slug 代入 pattern 的 :slug 段)+ list route 本身,來源是 seo-cache 的單一
// bounded 查詢(LIMIT 5000)。TTL 5 分鐘,此 route 本身不直接讀 settings/DB。
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const snap = await getSeoSnapshot();
  if (!snap.sitemapEnabled) return [];

  const origin = await resolveSiteOrigin(snap.siteUrl);
  return snap.sitemapUrls.map((u) => ({
    url: origin ? `${origin}${u.path}` : u.path,
    lastModified: new Date(u.lastModified),
  }));
}
