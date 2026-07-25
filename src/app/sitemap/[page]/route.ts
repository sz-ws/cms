import { getSeoSnapshot, resolveSiteOrigin } from "@/ext/dx/seo-cache";
import { escapeXml } from "@/ext/dx/seo-xml";

export const dynamic = "force-dynamic";

/** sitemap index 固定指向 /sitemap/<page>.xml；拒絕其他字串避免意外 alias。 */
const PAGE_RE = /^(0|[1-9]\d*)\.xml$/;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  const raw = (await ctx.params).page;
  const match = PAGE_RE.exec(raw);
  if (!match) return new Response("Not found", { status: 404 });

  const pageId = Number(match[1]);
  const snap = await getSeoSnapshot();
  if (!snap.sitemapEnabled) return new Response("Not found", { status: 404 });
  const page = snap.sitemapPages[pageId];
  if (!page) return new Response("Not found", { status: 404 });

  const origin = await resolveSiteOrigin(snap.siteUrl);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...page.urls.map((url) =>
      [
        "  <url>",
        `    <loc>${escapeXml(`${origin}${url.path}`)}</loc>`,
        `    <lastmod>${new Date(url.lastModified).toISOString()}</lastmod>`,
        "  </url>",
      ].join("\n"),
    ),
    "</urlset>",
  ].join("\n");

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
