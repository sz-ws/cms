import { getSeoSnapshot, resolveSiteOrigin } from "@/ext/dx/seo-cache";
import { escapeXml } from "@/ext/dx/seo-xml";

export const dynamic = "force-dynamic";

// 根端點是 sitemap index；child URL 在同一個 isolate TTL snapshot 裡取資料，所以
// crawler 依序抓多個 child 時不會把完整 contents 掃描重做多次。
export async function GET(): Promise<Response> {
  const snap = await getSeoSnapshot();
  const origin = await resolveSiteOrigin(snap.siteUrl);
  const sitemaps = snap.sitemapEnabled
    ? snap.sitemapPages
        .map((page) => {
          const loc = `${origin}/sitemap/${page.id}.xml`;
          return [
            "  <sitemap>",
            `    <loc>${escapeXml(loc)}</loc>`,
            `    <lastmod>${new Date(page.lastModified).toISOString()}</lastmod>`,
            "  </sitemap>",
          ].join("\n");
        })
        .join("\n")
    : "";
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    sitemaps,
    "</sitemapindex>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
