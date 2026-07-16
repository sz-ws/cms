import type { MetadataRoute } from "next";
import { getSeoSnapshot, resolveSiteOrigin } from "@/ext/dx/seo-cache";

export const dynamic = "force-dynamic";

// SEO 基礎:core.seo.robots 關閉時全站禁抓(Disallow: /,不論其他設定)。啟用時
// Allow /、Disallow /admin 與 /api,並在 core.seo.sitemap 也開啟時指向 sitemap.xml。
// 資料一律經 seo-cache 的 isolate TTL cache(5 分鐘)——此 route 本身不直接讀
// settings/DB。metadata route(此檔案的特殊 default export)不能自訂 Cache-Control
// header,快取責任完全落在 seo-cache 那層(不做 header hack)。
export default async function robots(): Promise<MetadataRoute.Robots> {
  const snap = await getSeoSnapshot();

  if (!snap.robotsEnabled) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const origin = await resolveSiteOrigin(snap.siteUrl);
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api"] }],
    sitemap: snap.sitemapEnabled && origin ? `${origin}/sitemap.xml` : undefined,
  };
}
