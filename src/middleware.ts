import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_PAGE_HEADER } from "@/lib/stamps";

// 渲染之前要決定的事,只剩後台一件:/admin 的廉價 cookie 存在性檢查(04 §4),真正驗證在
// layout / handler(不查 D1)。
//
// 2.0:middleware 只跑在 /admin。公開頁整頁存起來(見 (public)/[[...slug]]/page.tsx),
// OpenNext 在 Next server 之前就從快取回應;matcher 沒對到的路徑連 middleware 都不跑,
// 快取命中就少一段工作。CSP 全部是 next.config.ts 的固定標頭(公開頁 enforce publicPolicy,
// 其餘 Report-Only,組法在 @/lib/csp),快取命中時一樣會送。/login、/setup、/api、
// robots.txt 這類檔案也一樣不經過這裡。瀏覽器自己帶來的 PUBLIC_PAGE_HEADER 由 Worker 入口
// (custom-worker.ts)對每個請求刪掉。
export const config = { matcher: ["/admin", "/admin/:path*"] };

export async function middleware(req: NextRequest) {
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
