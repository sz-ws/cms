import { NextResponse, type NextRequest } from "next/server";

// 04 §4:只做廉價的 cookie 存在性檢查,真正驗證在 layout / handler(不查 D1)。
export const config = { matcher: ["/admin/:path*"] };

export function middleware(req: NextRequest) {
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
  return NextResponse.next({ request: { headers } });
}
