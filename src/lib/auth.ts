import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, lt } from "drizzle-orm";
import { db } from "./db";
import { sessions, users } from "./schema";
import { getEnv } from "./cf";
import {
  PBKDF2_ITERATIONS,
  PBKDF2_ROUNDS,
  isSupportedPasswordHashingIterations,
} from "./password-work-factor";

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

// ---- 密碼雜湊(04 §1:PBKDF2-HMAC-SHA256)----

// 界線常數住在 `./password-work-factor`（零 import），因為 client 端的校準精靈
// 也要用；從這裡 re-export 只是為了讓既有 server 端 import 不必改。
export {
  PBKDF2_EFFECTIVE_ITERATIONS,
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  PBKDF2_ROUNDS,
  isSupportedPasswordHashingIterations,
} from "./password-work-factor";

export interface PasswordHashingProfile {
  iterations: number;
  dummyHash: string;
}


/**
 * 帳號不存在時拿來燒掉等量時間的假 hash。內容永遠比不中,重點是**驗證它的成本
 * 要跟驗證真 hash 一樣**,否則回應時間就是帳號列舉的 oracle。
 *
 * 所以 pepper 旗標必須跟著目前的 env 走:verifyPassword 對旗標不符的 hash 會
 * 提早回 false(而且不做 derivation),那條捷徑一旦被夾在這裡,快慢差異就把
 * 「這個 email 不存在」洩出去了。
 */
function defaultDummyPasswordHash(): string {
  const peppered = passwordPepper() !== null ? 1 : 0;
  return `${CHAINED_PREFIX}$${PBKDF2_ROUNDS}$${PBKDF2_ITERATIONS}$${peppered}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
}


/**
 * 從自描述 hash 取「每輪」的工作因子;格式錯誤回 null,供 profile 完整性檢查共用。
 * 同時認得鏈式格式(pbkdf2c$rounds$iterations$…)與舊的單輪格式。
 */
export function passwordHashIterations(stored: string): number | null {
  const parts = stored.split("$");
  const raw =
    parts[0] === CHAINED_PREFIX && parts.length === 6
      ? parts[2]
      : parts.length === 4 && parts[0] === "pbkdf2"
        ? parts[1]
        : null;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const iterations = Number(raw);
  return Number.isSafeInteger(iterations) && iterations > 0 ? iterations : null;
}

/**
 * work factor 與 dummy hash 是同一筆不可拆的 profile：任何直接改 iterations、
 * 忘了重做 dummy hash 的值都會被拒絕，避免帳號列舉 oracle 倒轉回來。
 */
export function isPasswordHashingProfile(
  value: unknown,
): value is PasswordHashingProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<PasswordHashingProfile>;
  return (
    isSupportedPasswordHashingIterations(profile.iterations) &&
    typeof profile.dummyHash === "string" &&
    passwordHashIterations(profile.dummyHash) === profile.iterations
  );
}

/**
 * Pepper —— Worker secret `AUTH_PEPPER`,**不存在資料庫裡**。
 *
 * 它的價值只在一種情境:DB 被單獨拿走(dump 外洩、備份掉出去、D1 被讀)。
 * 沒有 pepper,離線爆破連開始都不可能 —— 攻擊者得先拿到 Worker 的 secret。
 * 這正好補上「每輪只能 100k」這件事最痛的地方:離線攻擊。
 *
 * 用 HMAC 而不是字串相接:相接會讓 pepper 與密碼的邊界可被構造(密碼裡塞
 * 分隔字元就能製造碰撞),HMAC 沒有這個問題,且輸出定長。
 *
 * 沒設定時回 null —— 本機開發不該被迫先設 secret。有沒有用 pepper 會記在
 * hash 字串裡,所以驗證端不需要猜。
 */
function passwordPepper(): string | null {
  let env: { AUTH_PEPPER?: string };
  try {
    env = getEnv() as unknown as { AUTH_PEPPER?: string };
  } catch {
    // 沒有 Cloudflare request context(單元測試、build 期預算)。這裡不能 throw:
    // 雜湊與驗證都會走到這條路,一 throw 就變成 500。回 null 代表「沒有 pepper」,
    // 而 hash 裡的旗標會忠實記下這件事 —— 用 pepper 產生的 hash 不會被誤判為通過。
    return null;
  }
  const raw = env.AUTH_PEPPER;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

async function applyPepper(password: string): Promise<Uint8Array<ArrayBuffer>> {
  const pepper = passwordPepper();
  if (!pepper) return enc(password);
  const key = await crypto.subtle.importKey(
    "raw",
    enc(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc(password));
  const out = bytes(mac.byteLength);
  out.set(new Uint8Array(mac));
  return out;
}

/**
 * 鏈式 PBKDF2:跑 `rounds` 輪,每輪 `iterations` 次,前一輪的輸出當下一輪的
 * 輸入密碼。每輪都在 Workers 的 100,000 上限之內,而攻擊者要重現一次猜測仍要
 * 付出全部輪數 —— 有效工作因子 = rounds × iterations。
 *
 * 每輪用同一個 salt:輪與輪之間的區隔已經由「上一輪的輸出」提供,再造不同 salt
 * 只是增加需要儲存的狀態,不增加安全性。
 */
async function deriveChained(
  material: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  rounds: number,
): Promise<Uint8Array<ArrayBuffer>> {
  let block = material;
  for (let i = 0; i < rounds; i++) {
    const key = await crypto.subtle.importKey("raw", block, "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    );
    const next = bytes(bits.byteLength);
    next.set(new Uint8Array(bits));
    block = next;
  }
  return block;
}

// 儲存格式(自描述,所以換方案不需要 migration):
//   pbkdf2c$<rounds>$<iterationsPerRound>$<pepper 0|1>$<salt b64>$<key b64>
// 舊的單輪格式 `pbkdf2$<iterations>$<salt>$<key>` 仍可驗證(見 verifyPassword)。
const CHAINED_PREFIX = "pbkdf2c";

async function derivePasswordHash(
  password: string,
  iterations: number,
  rounds: number = PBKDF2_ROUNDS,
): Promise<string> {
  const salt = randomBytes(16);
  const peppered = passwordPepper() !== null;
  const material = await applyPepper(password);
  const out = await deriveChained(material, salt, iterations, rounds);
  return `${CHAINED_PREFIX}$${rounds}$${iterations}$${peppered ? 1 : 0}$${b64(salt)}$${b64(out)}`;
}

/**
 * 新寫入一律由 active profile 帶入工作因子。呼叫端已持有已驗證 profile 時可
 * 直接傳入（setup 的同一 request），其餘產品寫入路徑由這裡集中取得 active 值。
 */
export async function hashPassword(
  password: string,
  profile?: PasswordHashingProfile,
): Promise<string> {
  return derivePasswordHash(
    password,
    (profile ?? (await getActivePasswordHashingProfile())).iterations,
  );
}

/**
 * 工作因子由平台上限與 PBKDF2_ROUNDS 決定,不是可設定值,所以這裡沒有讀設定,
 * 也沒有「已校準 / 未校準」兩種狀態。
 */
export async function getActivePasswordHashingProfile(): Promise<PasswordHashingProfile> {
  return {
    iterations: PBKDF2_ITERATIONS,
    dummyHash: defaultDummyPasswordHash(),
  };
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

  // 新格式:pbkdf2c$<rounds>$<iterations>$<pepper>$<salt>$<key>
  if (parts[0] === CHAINED_PREFIX) {
    if (parts.length !== 6) return false;
    const rounds = Number(parts[1]);
    const iterations = Number(parts[2]);
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 32) return false;
    if (!isSupportedPasswordHashingIterations(iterations)) return false;
    // hash 記錄了當初有沒有用 pepper。現在的 env 與當初不一致就直接失敗 ——
    // 若忽略這點,拔掉 pepper 會讓所有密碼安靜地驗不過而查不出原因。
    const wasPeppered = parts[3] === "1";
    if (wasPeppered !== (passwordPepper() !== null)) return false;
    const salt = unb64(parts[4]);
    const expected = unb64(parts[5]);
    const material = await applyPepper(password);
    const out = await deriveChained(material, salt, iterations, rounds);
    return constantTimeEqual(out, expected);
  }

  // 舊格式(單輪、無 pepper):pbkdf2$<iterations>$<salt>$<key>
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = passwordHashIterations(stored);
  // 上限必須擋在 deriveBits 之前。存著超過平台上限的 hash(例如早期在 Node 上
  // 跑 next dev 產生的 600k / 2.4M)時,直接送進 deriveBits 會拋
  // NotSupportedError 讓整個登入請求 500,而不是回「密碼不對」。
  if (!isSupportedPasswordHashingIterations(iterations)) return false;
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
