import { eq } from "drizzle-orm";
import { db } from "./db";
import { declarativeExtensions as dxTable } from "./schema";
import { linkIdentity, signInWithIdentity } from "./login-accounts";
import { getJwks, loadFirebaseConfig, safeNext, verifyJwt, type FirebaseWebConfig } from "./oidc";
import { parseManifest } from "@/ext/dx/manifest";

// 1.54.0:Firebase Authentication 登入(loginProvider.firebase)。
//
// Firebase 不是 OAuth 授權伺服器,沒有 authorization code 可以換:瀏覽器用 Firebase SDK
// 彈出登入視窗(components/auth/FirebaseSignInButton),拿到 Firebase 簽的 ID token,
// POST 到 /api/auth/firebase/<provider>。這裡照 Firebase 文件驗那個 token:
//   - RS256,簽章對得上 Google 的 securetoken JWKS;
//   - iss = https://securetoken.google.com/<projectId>、aud = <projectId>、exp 未過;
//   - iat、auth_time 不在未來;auth_time 在 10 分鐘內(SDK 用 in-memory persistence,
//     每次都是新的登入 —— 舊 token 被偷拿來換 session 的時間窗因此很短);
//   - firebase.sign_in_provider 等於 manifest 宣告的 signIn(例:google.com)。
// ID token 沒有 nonce;POST 端點有 same-origin 檢查,外站無法把自己的 token 塞進來。
// 通過後帳號對應和 OIDC 同一套(login-accounts.ts)。身分的 key 是 Firebase uid(sub)。

const FIREBASE_JWKS =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_AUTH_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
// Firebase 專案 id:小寫英數與連字號,6–30 字。擋掉會讓 iss 變形的值。
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/;

export type FirebaseLoginOutcome =
  | { kind: "session"; userId: string; location: string }
  | { kind: "linked" }
  | { kind: "error"; code: string };

export interface FirebaseLoginOptions {
  providerId: string;
  idToken: string;
  mode: "login" | "link";
  /** mode=link 必填(呼叫端已 requireAuth)。 */
  userId?: string;
  next?: string | null;
}

interface LoadedFirebaseProvider {
  config: FirebaseWebConfig;
  label: string;
}

async function loadFirebaseProvider(providerId: string): Promise<LoadedFirebaseProvider | null> {
  const rows = await db()
    .select({ manifest: dxTable.manifest, enabled: dxTable.enabled })
    .from(dxTable)
    .where(eq(dxTable.id, providerId))
    .limit(1);
  const row = rows[0];
  if (!row || row.enabled !== 1) return null;
  let parsed;
  try {
    parsed = parseManifest(JSON.parse(row.manifest));
  } catch {
    return null;
  }
  const lp = parsed.ok ? parsed.manifest?.loginProvider : undefined;
  if (!lp?.firebase) return null;
  const config = await loadFirebaseConfig(providerId, lp.firebase.signIn);
  if (!config || !PROJECT_ID_RE.test(config.projectId)) return null;
  return { config, label: lp.button.label };
}

function secondsClaim(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v * 1000 : null;
}

/** 驗 token、對應帳號。錯誤一律回機器可讀 code(不含上游細節)。 */
export async function completeFirebaseLogin(
  opts: FirebaseLoginOptions,
): Promise<FirebaseLoginOutcome> {
  const provider = await loadFirebaseProvider(opts.providerId);
  if (!provider) return { kind: "error", code: "provider_unavailable" };
  const { projectId, signIn } = provider.config;

  let verified;
  try {
    const jwks = await getJwks(FIREBASE_JWKS);
    verified = await verifyJwt(opts.idToken, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
  } catch {
    return { kind: "error", code: "oauth_failed" };
  }
  const { claims, payload } = verified;

  const now = Date.now();
  const iat = secondsClaim(payload, "iat");
  const authTime = secondsClaim(payload, "auth_time");
  if (iat === null || iat > now + CLOCK_SKEW_MS) return { kind: "error", code: "oauth_failed" };
  if (authTime === null || authTime > now + CLOCK_SKEW_MS) {
    return { kind: "error", code: "oauth_failed" };
  }
  if (authTime < now - MAX_AUTH_AGE_MS) return { kind: "error", code: "oauth_stale" };

  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  if (firebase?.sign_in_provider !== signIn) return { kind: "error", code: "oauth_failed" };

  // 明確「未驗證」的 email 視同沒有(同 OIDC)。
  if (claims.email_verified === false) claims.email = undefined;
  const display = claims.email ?? claims.name ?? null;

  try {
    if (opts.mode === "link") {
      if (!opts.userId) return { kind: "error", code: "oauth_failed" };
      const linked = await linkIdentity(opts.userId, opts.providerId, claims.sub, display);
      return linked === "linked" ? { kind: "linked" } : { kind: "error", code: "identity_taken" };
    }
    const result = await signInWithIdentity(opts.providerId, claims, display, provider.label);
    if (!result.ok) return { kind: "error", code: result.code };
    return { kind: "session", userId: result.userId, location: safeNext(opts.next) };
  } catch {
    return { kind: "error", code: "oauth_failed" };
  }
}
