// spec-login-providers.md §2:OAuth-only 且拿不到 provider email 的 user(如 LINE
// 未過 email scope 審核)會拿到合成的 placeholder email
// `oauth-<provider>-<sub16hex>@placeholder.invalid`(`.invalid` TLD 保證不可寄達;
// email 欄維持 NOT NULL UNIQUE)。此純函式 helper 是單一真相:寄信路徑用它跳過
// 不可寄達的收件人,UI 用它做遮罩(顯示「未提供 email」)。判準:小寫後以
// `@placeholder.invalid` 結尾 —— 只看結尾,不看中間那一段多長:1.76.0 以前建立的帳號那一段
// 是 8 碼(現在 16 碼,login-accounts.ts),兩種都是代用地址。要在別處(SQL)重寫這個判準時也只比結尾。
//
// 獨立成檔(而非留在 auth.ts)是因為 client 元件(如 UsersTable)也要遮罩顯示,
// 而 auth.ts 的相依鏈(next/headers、db)進不了 client bundle。auth.ts re-export
// 維持既有 server 端 import 路徑不變。

export const PLACEHOLDER_EMAIL_SUFFIX = "@placeholder.invalid";

export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_SUFFIX);
}
