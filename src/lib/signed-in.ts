// 1.56.0:auth:signed-in hook(型別註解在 src/ext/types.ts 的 HookName)。
//
// core 在每一條登入路徑建好 session、設好 cookie 之後呼叫 fireSignedIn:密碼
// (/api/auth/login)、Passkey、OAuth callback、Firebase、忘記密碼。插件自己的登入流程
// (例如會員插件的 Email 驗證碼)也可以呼叫它,讓其他插件收到同一個通知。
//
// 絕不擋登入:HookBus 本來就接住每個 handler 的錯;這裡再包一層,連 runtime 載不起來
// 也只記一筆錯誤類型(不記 userId、Email)。
//
// @/ext/loader 在函式裡動態載入:loader → registry → 插件 → 這個檔,靜態 import 會繞成循環。

export type SignInMethod = "password" | "passkey" | "oauth" | "firebase" | "reset" | "code";

export interface SignedInEvent {
  userId: string;
  method: SignInMethod;
  /** oauth / firebase:登入插件的 id;code:發驗證碼的插件 id。 */
  provider?: string;
  /** 這一次登入本身證明了帳號的 Email 是本人的(見 HookName 的說明)。 */
  emailVerified: boolean;
}

export async function fireSignedIn(event: SignedInEvent): Promise<void> {
  try {
    const { getExtRuntime } = await import("@/ext/loader");
    const runtime = await getExtRuntime();
    await runtime.hooks.doAction("auth:signed-in", event);
  } catch (error) {
    console.error("[auth] auth:signed-in could not run", error instanceof Error ? error.name : "error");
  }
}
