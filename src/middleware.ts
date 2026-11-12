import { NextResponse, type NextRequest } from "next/server";
import { getDB } from "@/lib/cf";
import { PREVIEW_COOKIE, isEditorSession, withoutPreviewCookie } from "@/lib/preview-access";

// 渲染之前要決定的事有兩件:
//   1. /admin 的廉價 cookie 存在性檢查(04 §4),真正驗證在 layout / handler(不查 D1)。
//   2. 2.0 草稿預覽:帶著 draft mode cookie 的公開頁請求,每次確認這個瀏覽器現在還是一位編輯
//      (src/lib/preview-access.ts)。不是 → cookie 從請求拿掉、回應裡刪掉,頁面照一般訪客回應。
//
// 公開頁整頁存起來(見 (public)/[[...slug]]/page.tsx),OpenNext 在 Next server 之前就從快取回應。
// 公開頁那條 matcher 帶 `has` cookie 條件:沒有 draft mode cookie 的請求,Next 不跑 middleware。
// OpenNext 只比對 matcher 的路徑、不看 `has`,所以函式自己再看一次 cookie,沒有就立刻放行。
// CSP 全部是 next.config.ts 的固定標頭(公開頁 enforce publicPolicy,其餘 Report-Only,組法在
// @/lib/csp),快取命中時一樣會送。/login、/setup、/api、_next 不經過這裡。
//
// 公開頁那條 source 與 @/lib/csp 的 PUBLIC_PAGES_SOURCE 相同(Next 要求 config 是字面值,不能
// import;test/public-csp.test.ts 比對兩者)。
export const config = {
  matcher: [
    "/admin",
    "/admin/:path*",
    {
      source: "/:path((?!admin$|admin/|login$|setup$|api/|_next/).*)",
      has: [{ type: "cookie", key: "__prerender_bypass" }],
    },
  ],
};

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export async function middleware(req: NextRequest) {
  if (!isAdminPath(req.nextUrl.pathname)) return previewGate(req);
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

async function previewGate(req: NextRequest) {
  if (!req.cookies.has(PREVIEW_COOKIE)) return NextResponse.next();
  if (await isEditorSession(getDB(), req.cookies.get("session")?.value)) return NextResponse.next();
  // 不是編輯了(登出、session 過期、權限被拿掉、複製來的 cookie):這一次照一般訪客回應(OpenNext
  // 看的是改過的 Cookie 標頭,快取照常命中),並讓瀏覽器丟掉這個 cookie。屬性與 Next 的
  // draftMode().disable() 相同。
  const headers = new Headers(req.headers);
  headers.set("cookie", withoutPreviewCookie(req.headers.get("cookie") ?? ""));
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(PREVIEW_COOKIE, "", {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    path: "/",
    expires: new Date(0),
  });
  return res;
}
