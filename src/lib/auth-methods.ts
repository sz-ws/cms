// L1 §4:輕量 auth-method 註冊表,為未來 Google OIDC provider 預留。
// 刻意不做 DB 開關、不做 provider 介面(YAGNI;Google 進來時再演化)。
// 登入頁是唯一消費者。
export interface AuthMethod {
  id: "password" | "passkey" | (string & {});
  label: string;
  primary?: boolean;
}

/** v1 hardcode:passkey 為主(primary),密碼保留為 recovery。 */
export function enabledAuthMethods(): AuthMethod[] {
  return [
    { id: "passkey", label: "Passkey", primary: true },
    { id: "password", label: "密碼" },
  ];
}
