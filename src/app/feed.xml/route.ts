import { getSeoSnapshot, resolveSiteOrigin } from "@/ext/dx/seo-cache";
import { escapeXml } from "@/ext/dx/seo-xml";

export const dynamic = "force-dynamic";

// SEO 基礎:RSS 2.0 feed。core.seo.rss 關閉 → 404(視同未提供此端點)。內容為
// seo-cache 快取好的最近 50 筆 published entries(updatedAt desc,已在 snapshot
// 內排序 + 截斷)。這是一般 Route Handler(非 metadata route 特殊檔),可自訂
// Cache-Control——搭配 seo-cache 的 isolate TTL(5 分鐘),兩層一致。
export async function GET(): Promise<Response> {
  const snap = await getSeoSnapshot();
  if (!snap.rssEnabled) {
    return new Response("Not found", { status: 404 });
  }

  const origin = await resolveSiteOrigin(snap.siteUrl);
  const channelLink = origin || "/";

  const itemsXml = snap.feedItems
    .map((item) => {
      const link = `${origin}${item.path}`;
      return [
        "    <item>",
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <pubDate>${new Date(item.pubDate).toUTCString()}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(snap.siteTitle)}</title>`,
    `    <link>${escapeXml(channelLink)}</link>`,
    `    <description>${escapeXml(snap.siteDescription)}</description>`,
    itemsXml,
    "  </channel>",
    "</rss>",
  ].join("\n");

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
