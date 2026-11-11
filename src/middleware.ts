import { NextResponse, type NextRequest } from "next/server";
import { isFilePath, reportOnlyPolicy } from "@/lib/csp";
import { PUBLIC_PAGE_HEADER } from "@/lib/stamps";

// 渲染之前要決定的事:
//   1. /admin:廉價的 cookie 存在性檢查(04 §4),真正驗證在 layout / handler(不查 D1)。
//   2. robots.txt、sitemap.xml 這類檔案補上 Report-Only(見 fileResponse)。
//   3. 瀏覽器自己帶來的 PUBLIC_PAGE_HEADER 一律刪掉(@/lib/stamps)。
//
// 2.0:公開頁整頁存起來(見 (public)/[[...slug]]/page.tsx),存起來的 HTML 對每個訪客都一樣,
// 放不進逐請求的 nonce,也不能依請求改戳的來源。所以公開頁在這裡原樣放行:CSP 改成
// next.config.ts 送的固定標頭(@/lib/csp 的 publicPolicy),快取命中時一樣會送。
//
// matcher 放寬到「除了 /api 與 Next 靜態檔以外全部」,路徑分流在下面做。
export const config = { matcher: ["/((?!api/|_next/).*)"] };

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return adminGate(req);
  if (isFilePath(pathname)) return fileResponse(req);
  return passThrough(req);
}

/**
 * 原樣放行。瀏覽器自己帶了 PUBLIC_PAGE_HEADER 才改寫請求標頭把它刪掉;沒帶(正常的
 * 請求)就與以前一字不差,不多產生任何標頭。
 */
function passThrough(req: NextRequest) {
  if (!req.headers.has(PUBLIC_PAGE_HEADER)) return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.delete(PUBLIC_PAGE_HEADER);
  return NextResponse.next({ request: { headers } });
}

/**
 * robots.txt、sitemap.xml、icon.svg 這類檔案:不在 next.config 的 Report-Only 路徑裡,
 * 也不是公開頁,由這裡補上後台那一份 Report-Only(不用 nonce、不查 D1)。
 */
function fileResponse(req: NextRequest) {
  const res = passThrough(req);
  res.headers.set("Content-Security-Policy-Report-Only", reportOnlyPolicy());
  return res;
}

function adminGate(req: NextRequest) {
  const hasCookie = req.cookies.has("session");
  if (!hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  // spec-login-providers.md §3:把當前 pathname 透過 request header 傳給 admin
  // layout(Server Component 無法直接拿 pathname),讓 guest gate 能判斷路徑。
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  headers.delete(PUBLIC_PAGE_HEADER);
  return NextResponse.next({ request: { headers } });
}
