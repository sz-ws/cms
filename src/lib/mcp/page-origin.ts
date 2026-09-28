import { headers } from "next/headers";
import { resolveMcpOrigin } from "./site";

/**
 * server component 版的 resolveMcpOrigin:頁面拿不到 req.url,只能從 host 標頭重建這次
 * 請求的 origin 當退路(core.siteUrl 有設就用它,規則見 site.ts)。
 *
 * 只讀 host,不讀 x-forwarded-host:後者是瀏覽器端可以自己加的標頭。本機開發沒有
 * x-forwarded-proto,loopback 用 http,其餘一律 https。
 */
export async function pageMcpOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost";
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || (loopback ? "http" : "https");
  return resolveMcpOrigin(`${proto === "http" ? "http" : "https"}://${host}`);
}
