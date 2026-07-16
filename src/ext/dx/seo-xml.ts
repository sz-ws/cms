// SEO feed(RSS 2.0)XML 跳脫。title/link/description/guid 皆為 text node,需跳脫
// `& < > " '`。純函式,無 I/O——獨立於 seo-cache.ts,方便單元測試。
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
