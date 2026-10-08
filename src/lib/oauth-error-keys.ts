// 第三方登入帶回來的機器可讀錯誤碼 → 字典鍵。純函式:登入頁、帳號頁用,測試也直接呼叫。
// 錯誤碼從哪來:src/lib/oidc.ts(?error= / ?login_error=)與 Firebase 登入按鈕的 onError。

/** 後台登入頁(/login?error=<code>)。不認得的一律泛化。 */
export function oauthErrorKey(code: string) {
  switch (code) {
    case "oauth_denied":
      return "login.error.oauthDenied" as const;
    case "oauth_state":
    case "oauth_stale":
      return "login.error.oauthState" as const;
    // 1.76.0:callback 到了不是開始登入的那個瀏覽器。
    case "oauth_browser":
      return "login.error.oauthBrowser" as const;
    case "popup_blocked":
      return "login.error.popupBlocked" as const;
    case "not_linked":
      return "login.error.notLinked" as const;
    case "email_exists":
      return "login.error.emailExists" as const;
    default:
      return "login.error.oauthFailed" as const;
  }
}

/** 帳號頁「已連結帳號」(/admin/account?error=<code>)。 */
export function identityErrorKey(code: string) {
  switch (code) {
    case "identity_taken":
      return "account.error.identityTaken" as const;
    case "oauth_browser":
      return "account.error.identityBrowser" as const;
    default:
      return "account.error.identityGeneric" as const;
  }
}
