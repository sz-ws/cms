// 2.0:登入提示 cookie。session cookie 是 HttpOnly,瀏覽器讀不到;存起來的公開頁(同一份 HTML
// 給每個訪客)要在瀏覽器決定「值不值得問伺服器這位訪客是誰」,就看這個。
//
// 值只有 "1",不帶任何身分;登入時與 session 一起設(auth.ts 的 setSessionCookies)、登出時一起清。
// 它只決定要不要問:是不是登入、是誰,照舊由伺服器讀 session 回答。session 在伺服器端失效(過期、
// 被別處登出)時提示可能還在,代價只是多問一次,回答仍是「沒登入」。
//
// 沒有任何 server import,client 元件可以直接用。

export const SIGNED_IN_HINT_COOKIE = "signed_in";

/** document.cookie(或 Cookie header)裡有沒有登入提示。 */
export function hasSignedInHint(cookie: string): boolean {
  return cookie.split(";").some((part) => part.trim() === `${SIGNED_IN_HINT_COOKIE}=1`);
}
