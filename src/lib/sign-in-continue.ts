// 1.55.0:統一登入入口的「登入後去哪」。純函式,server(/api/auth/continue)與插件的
// client 元件都 import(沒有任何 server 依賴)。
//
// 所有人從同一個登入頁登入(Extension.signInPage;沒有的話是 /login),登入成功後一律
// 導到 /api/auth/continue?next=<明確要去的頁>&stay=<登入頁本身>,由伺服器依身分決定:
//   - 後台人員(role 不是 guest;自訂角色也算):next,沒有就 /admin。
//   - 會員:next(但不進後台、登入頁、API),沒有就 stay(回登入頁,畫「已登入」),再沒有就 /。

export const CONTINUE_PATH = "/api/auth/continue";

/** 同站絕對路徑(單一 "/" 起頭、非 "//"、無反斜線與控制字元)才算數。 */
export function sitePath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  for (let i = 0; i < path.length; i++) {
    const unit = path.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return null;
  }
  return path;
}

/** 會員不該被帶去的地方:後台、登入頁、首次設定、API。 */
function staffOnly(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0].toLowerCase();
  return /^\/(admin|login|setup|api)(\/|$)/.test(pathname);
}

/** 登入後的目的地。staff = 後台人員。 */
export function signedInDestination(
  staff: boolean,
  next: string | null | undefined,
  stay: string | null | undefined,
): string {
  const wanted = sitePath(next);
  if (staff) return wanted ?? "/admin";
  if (wanted && !staffOnly(wanted)) return wanted;
  const back = sitePath(stay);
  if (back && !staffOnly(back)) return back;
  return "/";
}

/** 登入成功後要導去的網址(交給 /api/auth/continue 分流)。 */
export function continueUrl(next: string | null | undefined, stay: string | null | undefined): string {
  const params = new URLSearchParams();
  const wanted = sitePath(next);
  const back = sitePath(stay);
  if (wanted) params.set("next", wanted);
  if (back) params.set("stay", back);
  const query = params.toString();
  return query ? `${CONTINUE_PATH}?${query}` : CONTINUE_PATH;
}
