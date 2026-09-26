import { getApps, initializeApp } from "firebase/app";
import {
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  signInWithPopup,
  signOut,
  type Auth,
  type AuthProvider,
} from "firebase/auth";
import type { FirebaseWebConfig } from "@/lib/oidc";

// Firebase SDK 的瀏覽器端(1.54.0)。只由 FirebaseSignInButton 動態 import:SDK 不進
// 一般頁面的 bundle,只有畫出 Firebase 登入按鈕的頁面才下載。
//
// - persistence 用 inMemory:Firebase 的登入狀態不留在瀏覽器,拿到 ID token 就登出;
//   站台自己的 session cookie 才是登入狀態。每次都是新的登入,伺服器才能要求 auth_time
//   在幾分鐘內。
// - initializeAuth 時就給 popupRedirectResolver,SDK 會先把 authDomain 的 iframe 暖好;
//   按下按鈕時 signInWithPopup 才能在同一個點擊裡開出視窗(不然 Safari 會擋)。

const auths = new Map<string, Auth>();

/** 準備好這個設定的 Auth(同一頁多顆按鈕、重畫都共用一份)。 */
export function prepareAuth(config: FirebaseWebConfig): Auth {
  const name = `cms-login-${config.projectId}`;
  const cached = auths.get(name);
  if (cached) return cached;
  const existing = getApps().find((app) => app.name === name);
  const app =
    existing ??
    initializeApp(
      { apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId },
      name,
    );
  const auth = existing
    ? getAuth(app)
    : initializeAuth(app, {
        persistence: inMemoryPersistence,
        popupRedirectResolver: browserPopupRedirectResolver,
      });
  auths.set(name, auth);
  return auth;
}

function providerFor(signIn: string): AuthProvider {
  // manifest 目前只允許 google.com(FIREBASE_SIGN_IN_METHODS)。
  if (signIn !== "google.com") throw new Error(`unsupported sign-in method ${signIn}`);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

/** 彈出登入視窗 → Firebase ID token。要在點擊的處理函式裡同步呼叫。 */
export async function popupIdToken(auth: Auth, signIn: string): Promise<string> {
  const credential = await signInWithPopup(auth, providerFor(signIn));
  try {
    return await credential.user.getIdToken();
  } finally {
    await signOut(auth).catch(() => undefined);
  }
}
