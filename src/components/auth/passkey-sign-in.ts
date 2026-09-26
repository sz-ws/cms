import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

// Passkey 登入的瀏覽器端(1.55.0 從後台登入表單抽出來;後台 /login 與統一登入頁共用)。
// options → startAuthentication(usernameless,discoverable credential)→ verify。
// 成功時 core 已經設好 session cookie,呼叫端自己決定換到哪一頁。

export type PasskeySignInResult = "ok" | "cancelled" | "rate_limited" | "failed";

export async function signInWithPasskey(): Promise<PasskeySignInResult> {
  let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  try {
    const optRes = await fetch("/api/auth/passkey/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!optRes.ok) return "cancelled";
    optionsJSON = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;
  } catch {
    return "cancelled";
  }

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON });
  } catch {
    // 使用者取消 / 這台裝置沒有 passkey。
    return "cancelled";
  }

  try {
    const verifyRes = await fetch("/api/auth/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assertion),
    });
    if (verifyRes.ok) return "ok";
    return verifyRes.status === 429 ? "rate_limited" : "failed";
  } catch {
    return "cancelled";
  }
}
