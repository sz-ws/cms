import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { userIdentities, users } from "./schema";
import { getSetting } from "./settings";
import { PLACEHOLDER_EMAIL_SUFFIX } from "./placeholder-email";

// 第三方登入(OIDC 與 Firebase)共用的帳號對應:身分 → users 列。
// 驗 token 是各自引擎的事(oidc.ts / firebase-login.ts);這裡只拿「已驗證過的 claims」。
//
// Email 撞到既有帳號(1.54.0):
//   - IdP 明確說 email 已驗證(email_verified === true)、那個帳號是一般會員(role guest、
//     沒有自訂角色),而且它的 Email 也被證明過(users.email_verified_at 有值)→ 直接綁上
//     並登入。會員插件本來就用「證明信箱」當登入方式,Google 驗過的信箱是同一種證明。
//   - 帳號的 Email 沒被證明過(管理員手動建、寄不出信時直接註冊)不自動綁:否則有人可以
//     先用別人的信箱註冊、設好密碼,等信箱主人用 Google 登入後共用這個帳號(預先劫持)。
//   - 後台人員(admin/editor/自訂角色)一律不自動綁(防接管),要登入後從帳號頁連結。
//   - 沒有 email_verified(如 LINE)也不自動綁。
// 以已驗證 Email 建立的新帳號會記下 email_verified_at。

export const SENTINEL_PASSWORD_HASH = "!oauth-only"; // 非 pbkdf2 格式 → verifyPassword 恆 false

export interface LoginClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; code: "not_linked" | "email_exists" };

export type LinkResult = "linked" | "identity_taken";

function toHex(u8: Uint8Array): string {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function upsertLastUsed(identityId: string): Promise<void> {
  await db()
    .update(userIdentities)
    .set({ lastUsedAt: Date.now() })
    .where(eq(userIdentities.id, identityId));
}

async function insertIdentity(
  userId: string,
  providerId: string,
  sub: string,
  display: string | null,
): Promise<void> {
  await db().insert(userIdentities).values({
    id: crypto.randomUUID(),
    userId,
    provider: providerId,
    providerUserId: sub,
    display,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
}

async function findIdentity(
  providerId: string,
  sub: string,
): Promise<{ id: string; userId: string } | undefined> {
  const rows = await db()
    .select({ id: userIdentities.id, userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, providerId), eq(userIdentities.providerUserId, sub)))
    .limit(1);
  return rows[0];
}

/** 建立第三方登入的新帳號(role=guest、sentinel 密碼、真實或 placeholder email)。 */
async function createGuestUser(
  providerId: string,
  claims: LoginClaims,
  fallbackName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  // placeholder email(spec §2):`.invalid` TLD 保證不可寄達;sub 前 8 碼 hex 由
  // SHA-256(sub) 取(sub 本身未必是 hex,雜湊後取前 8 hex 保證格式且穩定)。
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(claims.sub));
  const subHex = toHex(new Uint8Array(digest)).slice(0, 8);
  const email =
    claims.email && claims.email.length > 0
      ? claims.email.toLowerCase()
      : `oauth-${providerId}-${subHex}${PLACEHOLDER_EMAIL_SUFFIX}`;
  const name = claims.name && claims.name.length > 0 ? claims.name : fallbackName;
  const now = Date.now();
  const verified = Boolean(claims.email) && claims.email_verified === true;
  await db().insert(users).values({
    id,
    email,
    passwordHash: SENTINEL_PASSWORD_HASH,
    name,
    role: "guest",
    createdAt: now,
    emailVerifiedAt: verified ? now : null,
  });
  return id;
}

/**
 * 記下「這個帳號的 Email 已被證明是本人的」(第一次的時間,之後不覆蓋)。會員插件在
 * 驗證碼流程通過後呼叫。
 */
export async function markEmailVerified(userId: string): Promise<void> {
  await db()
    .update(users)
    .set({ emailVerifiedAt: Date.now() })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
}

/**
 * 登入:已綁的身分直接登入;沒綁 → 依註冊 policy 建新帳號,或(email 已驗證的一般會員)
 * 綁上既有帳號。呼叫端要先把「未驗證」的 email 拿掉(email_verified === false)。
 */
export async function signInWithIdentity(
  providerId: string,
  claims: LoginClaims,
  display: string | null,
  fallbackName: string,
): Promise<LoginResult> {
  const identity = await findIdentity(providerId, claims.sub);
  if (identity) {
    await upsertLastUsed(identity.id);
    return { ok: true, userId: identity.userId };
  }

  const policy = await getSetting<string>("core.auth.oauthRegistration", "guest");
  if (policy !== "guest") return { ok: false, code: "not_linked" };

  if (claims.email) {
    const clash = await db()
      .select({
        id: users.id,
        role: users.role,
        staffRoleId: users.staffRoleId,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, claims.email.toLowerCase()))
      .limit(1);
    const existing = clash[0];
    if (existing) {
      const member = existing.role === "guest" && existing.staffRoleId === null;
      const proven = existing.emailVerifiedAt !== null;
      if (!member || !proven || claims.email_verified !== true) {
        return { ok: false, code: "email_exists" };
      }
      await insertIdentity(existing.id, providerId, claims.sub, display);
      return { ok: true, userId: existing.id };
    }
  }

  const userId = await createGuestUser(providerId, claims, fallbackName);
  await insertIdentity(userId, providerId, claims.sub, display);
  return { ok: true, userId };
}

/** 帳號頁的「連結」:把身分綁到已登入的 user;已綁在別人身上就拒絕。 */
export async function linkIdentity(
  userId: string,
  providerId: string,
  sub: string,
  display: string | null,
): Promise<LinkResult> {
  const identity = await findIdentity(providerId, sub);
  if (identity && identity.userId !== userId) return "identity_taken";
  if (identity) {
    await upsertLastUsed(identity.id);
    return "linked";
  }
  await insertIdentity(userId, providerId, sub, display);
  return "linked";
}
