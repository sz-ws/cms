import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, lt } from "drizzle-orm";
import { db } from "./db";
import { sessions, users } from "./schema";

// ---- 型別 ----

// spec-login-providers.md §3:新增 "guest"(訪客)。層級 admin > editor > guest。
export type UserRole = "admin" | "editor" | "guest";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  // 0008:使用者頭像 storage key(lib/storage.ts scope "avatars");NULL = 未設定。
  avatarKey: string | null;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403) {
    super(status === 401 ? "unauthorized" : "forbidden");
  }
}

// placeholder email helper 移至 ./placeholder-email(client 元件也要遮罩顯示,
// auth.ts 的 server 相依鏈進不了 client bundle);此處 re-export 維持既有 import 路徑。
export {
  PLACEHOLDER_EMAIL_SUFFIX,
  isPlaceholderEmail,
} from "./placeholder-email";

// ---- base64 helpers(04 §1)----

// 明確以 ArrayBuffer 為 backing(避免 DOM/workerd lib 的 BufferSource 型別衝突)。
function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}

const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes(len));
}

// TextEncoder().encode 在新版 lib 回 Uint8Array<ArrayBufferLike>;複製成 ArrayBuffer backing。
function enc(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = bytes(src.length);
  out.set(src);
  return out;
}

const toHex = (u8: Uint8Array): string =>
  Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ---- 密碼雜湊(04 §1:PBKDF2-HMAC-SHA256,600k iterations)----

// PBKDF2 成本註記(04 §5):600k iterations 在 Workers 上約數十 ms CPU。
// 若免費方案碰到 CPU 上限,降到 210k(OWASP 下限)並在此記錄。實測未觸頂,維持 600k。
const PBKDF2_ITERATIONS = 600_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey(
    "raw",
    enc(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** 逐 byte XOR 累積的 constant-time 比對(04 §1)。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  // 格式:pbkdf2$<iterations>$<salt b64>$<hash b64>
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = unb64(parts[2]);
  const expected = unb64(parts[3]);
  const key = await crypto.subtle.importKey(
    "raw",
    enc(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  );
  return constantTimeEqual(new Uint8Array(bits), expected);
}

/**
 * 固定 dummy hash(04 §5):帳號不存在時也對它跑一次 verifyPassword,
 * 消除回應時間差造成的帳號列舉 oracle。內容永不會被任何真實密碼命中。
 */
export const DUMMY_PASSWORD_HASH =
  "pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---- Session(04 §2)----

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** SHA-256(token) 的 hex(D1 只存這個)。 */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc(token),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * 建立 session,回傳「原始 token」(給 cookie 用);D1 存的是它的 SHA-256(sessions.id)。
 * 不在此設 cookie(呼叫端 route handler 設,才能拿到 Set-Cookie 控制)。
 */
export async function createSession(userId: string): Promise<string> {
  const raw = toHex(randomBytes(32)); // 64 hex 字元
  const id = await hashToken(raw);
  const now = Date.now();
  await db().insert(sessions).values({
    id,
    userId,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
  });
  return raw;
}

/** cookie 屬性(04 §2)。 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
export { SESSION_COOKIE };

/**
 * 讀 cookie → 查 D1(JOIN users)→ 過期回 null + 順手刪列。
 * React cache() 包裝:同一 request 多處呼叫只查一次。
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const id = await hashToken(raw);
  const now = Date.now();
  const rows = await db()
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarKey: users.avatarKey,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt <= now) {
    // 過期:順手刪列
    await db().delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return {
    id: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarKey: row.avatarKey,
  };
});

/** 刪 D1 列 + 清 cookie(04 §2)。 */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    const id = await hashToken(raw);
    await db().delete(sessions).where(eq(sessions.id, id));
  }
  store.delete(SESSION_COOKIE);
}

/** login 成功時順手刪除該 user 的過期 sessions(免 cron,04 §2)。 */
export async function purgeExpiredSessions(userId: string): Promise<void> {
  await db()
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, Date.now())));
}

// spec-login-providers.md §3:role 層級(數字越大權限越高)。requireAuth 改為
// 「最低門檻」語意:呼叫者的 role 等級須 >= minRole 等級,否則 403。
const ROLE_RANK: Record<UserRole, number> = { guest: 1, editor: 2, admin: 3 };

/**
 * 未登入 throw 401;role 低於最低門檻 throw 403。
 *
 * **最低門檻語意(關鍵安全點,spec-login-providers.md §3)**:minRole 預設
 * `"editor"` —— 所有既有 `requireAuth()`(無參數)呼叫點行為不變(admin/editor
 * 皆通過),而新角色 guest 自動被 403。只有明確 `requireAuth("guest")` 的端點
 * (帳號頁自身 API)才放行 guest。`requireAuth("admin")` 沿用不變(僅 admin)。
 */
export async function requireAuth(
  minRole: UserRole = "editor",
): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError(401);
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) throw new AuthError(403);
  return user;
}

/** route handler 共用:AuthError → JSON;否則 null(見 04 §5 慣例)。 */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return null;
}
