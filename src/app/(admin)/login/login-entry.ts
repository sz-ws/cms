// 2.0:/login 是存起來的頁面(見 [[...rest]]/page.tsx),HTML 對每個訪客都一樣。以前伺服器每次讀
// searchParams 決定的事,現在由瀏覽器讀網址決定;純函式,沒有任何 server 依賴。
//
// 決定的順序與 1.55.0 起的伺服器版本相同:
//   1. 還沒有任何使用者 → /setup。
//   2. 網站有自己的登入頁(插件宣告 signInPage)且不是 ?form=1 → 轉過去,帶著 next 與錯誤碼
//      (錯誤碼改名 login_error)。已經登入的人由那一頁處理。
//   3. 瀏覽器帶著登入提示(signed-in-hint.ts)→ 交給 /api/auth/continue:伺服器驗 session、驗 next、
//      決定去哪;session 其實不在就清掉提示、回到登入頁。沒有提示的訪客不問伺服器。
//   4. 其餘:登入表單,next 與 OAuth 錯誤碼交給表單(next 在表單裡照舊用 safeNext 驗)。

import { CONTINUE_PATH } from "@/lib/sign-in-continue";

export type LoginEntryDecision =
  | { kind: "go"; href: string }
  | { kind: "signed-in"; href: string }
  | { kind: "form"; next: string | undefined; oauthError: string | undefined };

export interface LoginEntryInput {
  /** location.search(可帶或不帶開頭的 "?")。 */
  search: string;
  /** 插件宣告的網站登入頁;沒有是 null。 */
  signInPage: string | null;
  /** 瀏覽器有沒有登入提示 cookie。 */
  signedInHint: boolean;
  /** 頁面算出來的時候還沒有任何使用者。 */
  needsSetup: boolean;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function decideLoginEntry(input: LoginEntryInput): LoginEntryDecision {
  if (input.needsSetup) return { kind: "go", href: "/setup" };
  const sp = new URLSearchParams(input.search);
  const next = sp.get("next") ?? undefined;
  const oauthError = sp.get("error") ?? undefined;
  const formOnly = sp.get("form") === "1";

  if (input.signInPage && !formOnly) {
    const params = new URLSearchParams();
    if (next) params.set("next", next);
    if (oauthError) params.set("login_error", oauthError);
    return { kind: "go", href: withQuery(input.signInPage, params) };
  }
  if (input.signedInHint && !formOnly) {
    const params = new URLSearchParams();
    if (next) params.set("next", next);
    return { kind: "signed-in", href: withQuery(CONTINUE_PATH, params) };
  }
  return { kind: "form", next, oauthError };
}
