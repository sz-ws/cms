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
//
// 對方沒有明講「已驗證」的 email(email_verified 不是 true:沒有這個 claim、false、不是布林)在這裡一律當作
// 沒給(provenEmail):不會變成帳號的 Email、不拿來比對既有帳號。LINE 的 ID token 有 email 但沒有
// email_verified,文件也沒說那個地址驗證過;以前這種 email 直接成為新帳號的 Email,等於讓人用別人的地址
// 開帳號 —— 信箱的主人之後用驗證碼登入,會進到一個對方的身分也進得來的帳號(預先劫持)。現在這種登入
// 拿到的是沒有 Email 的帳號(代用地址,見 createGuestUser);要補 Email 是插件的事(例如會員插件用驗證碼
// 證明信箱之後才寫進帳號),core 只提供登入後多走一步的插槽(src/ext/after-sign-in.ts)。
//
// 1.56.0:登入結果多帶 emailVerified —— 這一次登入本身有沒有證明帳號的 Email 是本人的
// (IdP 說 email_verified === true,而且那個 Email 就是帳號的 Email)。core 把它放進
// auth:signed-in hook(src/lib/signed-in.ts),插件據此做「證明過信箱才做的事」。

export const SENTINEL_PASSWORD_HASH = "!oauth-only"; // 非 pbkdf2 格式 → verifyPassword 恆 false

/** 代用地址(placeholder email)裡 SHA-256(sub) 取幾碼 hex。16 碼 = 64 bit,兩個人撞在一起的機會可以不計。 */
const PLACEHOLDER_SUB_HEX = 16;

export interface LoginClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export type LoginResult =
  | { ok: true; userId: string; emailVerified: boolean }
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

/** IdP 證明過的 email(小寫);沒說驗證過、說沒有、或根本沒給都是 null。帳號的 Email 只認這個。 */
function provenEmail(claims: LoginClaims): string | null {
  return claims.email_verified === true && typeof claims.email === "string" && claims.email.length > 0
    ? claims.email.toLowerCase()
    : null;
}

/** IdP 證明了 email,而且它就是帳號的 Email(大小寫不計)。 */
function provesEmail(claims: LoginClaims, accountEmail: string): boolean {
  return provenEmail(claims) === accountEmail.toLowerCase();
}

async function accountEmail(userId: string): Promise<string | null> {
  const rows = await db().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.email ?? null;
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

/**
 * 建立第三方登入的新帳號(role=guest、sentinel 密碼)。Email:IdP 證明過的才用;其他一律是 placeholder
 * (isPlaceholderEmail 認得的代用地址),也就是「這個帳號沒有留 Email」。
 */
async function createGuestUser(
  providerId: string,
  claims: LoginClaims,
  fallbackName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  // placeholder email(spec §2):`.invalid` TLD 保證不可寄達;中間那一段是 SHA-256(sub) 的前 16 碼 hex
  // (sub 本身未必是 hex,雜湊後取保證格式且穩定)。1.76.0 以前只取 8 碼:同一個登入方式下兩個人撞在一起的話,
  // 第二個人建帳號時撞上 email 的 UNIQUE,登入就失敗。舊帳號的地址不改;認代用地址只看結尾(isPlaceholderEmail)。
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(claims.sub));
  const subHex = toHex(new Uint8Array(digest)).slice(0, PLACEHOLDER_SUB_HEX);
  const proven = provenEmail(claims);
  const email = proven ?? `oauth-${providerId}-${subHex}${PLACEHOLDER_EMAIL_SUFFIX}`;
  const name = claims.name && claims.name.length > 0 ? claims.name : fallbackName;
  const now = Date.now();
  await db().insert(users).values({
    id,
    email,
    passwordHash: SENTINEL_PASSWORD_HASH,
    name,
    role: "guest",
    createdAt: now,
    emailVerifiedAt: proven ? now : null,
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
 * 綁上既有帳號。IdP 沒有證明過的 email 在這裡不算數(provenEmail),呼叫端不必先拿掉。
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
    const email = await accountEmail(identity.userId);
    return { ok: true, userId: identity.userId, emailVerified: email !== null && provesEmail(claims, email) };
  }

  const policy = await getSetting<string>("core.auth.oauthRegistration", "guest");
  if (policy !== "guest") return { ok: false, code: "not_linked" };

  const vouched = provenEmail(claims);
  if (vouched) {
    const clash = await db()
      .select({
        id: users.id,
        role: users.role,
        staffRoleId: users.staffRoleId,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, vouched))
      .limit(1);
    const existing = clash[0];
    if (existing) {
      const member = existing.role === "guest" && existing.staffRoleId === null;
      const proven = existing.emailVerifiedAt !== null;
      if (!member || !proven) return { ok: false, code: "email_exists" };
      await insertIdentity(existing.id, providerId, claims.sub, display);
      return { ok: true, userId: existing.id, emailVerified: true };
    }
  }

  const userId = await createGuestUser(providerId, claims, fallbackName);
  await insertIdentity(userId, providerId, claims.sub, display);
  // 新帳號的 Email 就是 IdP 證明過的那個(有的話);沒有就是沒留 Email,這次登入也就沒證明什麼。
  return { ok: true, userId, emailVerified: vouched !== null };
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
