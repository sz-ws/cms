import { getEnv } from "./cf";
import { timingSafeEqualString } from "./security";

// 1.56.0:忘記密碼的 Email 驗證碼(表:migrations/0023_password_reset_codes.sql)。全部是帶
// D1 參數的函式,時間由呼叫端給,測試直接對真 D1 跑。流程與限速在 password-reset.ts。
//
// 規則:6 位數字、10 分鐘有效、同一組碼最多試 5 次、60 秒內不能重寄;驗證通過(同一個請求
// 裡就換好密碼)後碼就作廢。和會員插件的驗證碼同一套規則,但表與金鑰分開:插件停用或
// 解除安裝都不影響後台人員重設密碼。
//
// 驗證碼不寫進任何 log。

export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 5;
/** 一天前寄出的列一定已經失效,發碼時順手清掉。 */
const SWEEP_AFTER_MS = 24 * 60 * 60_000;

function bytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len));
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(text);
  const out = bytes(src.length);
  out.set(src);
  return out;
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

function randomHex(len: number): string {
  return hex(crypto.getRandomValues(bytes(len)).buffer);
}

/** 均勻的 6 位數字:拒絕取樣,4,294,000,000 是 1,000,000 的倍數,取餘數不偏。 */
function randomCode(): string {
  const box = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(box);
    if (box[0] < 4_294_000_000) return String(box[0] % 1_000_000).padStart(6, "0");
  }
}

function secretsKey(): string | null {
  try {
    const raw = (getEnv() as unknown as { SECRETS_KEY?: string }).SECRETS_KEY;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

/**
 * 驗證碼只有一百萬種,單純的 SHA-256 在資料庫外洩時一秒就能還原。所以用 SECRETS_KEY
 * 經 HKDF 導出一把專用的 HMAC 金鑰(salt/info 和 settings 的 AES、插件的驗證碼都不同):
 * 只拿到 D1 的人算不出碼。沒有 SECRETS_KEY 時退回加 nonce 的 SHA-256,碼一樣 10 分鐘就失效。
 */
function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = crypto.subtle
    .importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8("core.auth"), info: utf8("password-reset/v1") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      ),
    );
  cachedKey = { secret, key };
  return key;
}

async function codeDigest(nonce: string, email: string, code: string): Promise<string> {
  const message = utf8(`${nonce}\n${email}\n${code}`);
  const secret = secretsKey();
  if (!secret) return hex(await crypto.subtle.digest("SHA-256", message));
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), message));
}

/** 還要等多久才能重寄(毫秒);0 = 現在就能寄。 */
export async function cooldownRemaining(db: D1Database, email: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT sent_at FROM password_reset_codes WHERE email = ?")
    .bind(email)
    .first<{ sent_at: number }>();
  return row ? Math.max(0, row.sent_at + RESEND_AFTER_MS - now) : 0;
}

export type IssueResult =
  | { ok: true; code: string; nonce: string }
  | { ok: false; retryInMs: number };

/**
 * 產生一組新碼並存雜湊。距離上一次寄出不到 60 秒就不寫(條件寫在同一條 upsert 裡,
 * 兩個分頁同時按也只會有一個成功)。新碼讓舊碼失效。
 */
export async function issueCode(db: D1Database, email: string, now: number): Promise<IssueResult> {
  const code = randomCode();
  const nonce = randomHex(16);
  const digest = await codeDigest(nonce, email, code);
  const [, written] = await db.batch([
    db.prepare("DELETE FROM password_reset_codes WHERE sent_at < ?").bind(now - SWEEP_AFTER_MS),
    db
      .prepare(
        `INSERT INTO password_reset_codes (email, nonce, code_hash, attempts, sent_at, expires_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5)
         ON CONFLICT(email) DO UPDATE SET nonce = excluded.nonce, code_hash = excluded.code_hash, attempts = 0,
           sent_at = excluded.sent_at, expires_at = excluded.expires_at
         WHERE password_reset_codes.sent_at <= ?6`,
      )
      .bind(email, nonce, digest, now, now + CODE_TTL_MS, now - RESEND_AFTER_MS),
  ]);
  if (written.meta.changes === 1) return { ok: true, code, nonce };
  return { ok: false, retryInMs: Math.max(1_000, await cooldownRemaining(db, email, now)) };
}

/** 信沒寄出去:作廢這組碼、把冷卻時間退回去,不必等 60 秒就能再按一次。 */
export async function withdrawCode(db: D1Database, email: string, nonce: string): Promise<void> {
  await db
    .prepare("UPDATE password_reset_codes SET code_hash = NULL, sent_at = sent_at - ? WHERE email = ? AND nonce = ?")
    .bind(RESEND_AFTER_MS, email, nonce)
    .run();
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "wrong"; attemptsLeft: number }
  | { ok: false; reason: "expired" };

/**
 * 比對驗證碼。先原子地記一次嘗試(沒過期、沒用過、還沒到 5 次的碼才記得上),再比對;
 * 對了就把碼作廢 —— 作廢的條件是「還是同一組碼」,同一組碼只會成功一次。
 * 不存在、過期、用過、試滿 5 次一律回 expired:該做的事都一樣(重寄)。
 */
export async function checkCode(db: D1Database, email: string, code: string, now: number): Promise<CheckResult> {
  const row = await db
    .prepare(
      `UPDATE password_reset_codes SET attempts = attempts + 1
       WHERE email = ? AND code_hash IS NOT NULL AND expires_at > ? AND attempts < ?
       RETURNING nonce, code_hash, attempts`,
    )
    .bind(email, now, MAX_ATTEMPTS)
    .first<{ nonce: string; code_hash: string; attempts: number }>();
  if (!row) return { ok: false, reason: "expired" };
  const matches =
    /^\d{6}$/.test(code) && timingSafeEqualString(await codeDigest(row.nonce, email, code), row.code_hash);
  if (!matches) {
    const attemptsLeft = MAX_ATTEMPTS - row.attempts;
    if (attemptsLeft > 0) return { ok: false, reason: "wrong", attemptsLeft };
    await db
      .prepare("UPDATE password_reset_codes SET code_hash = NULL WHERE email = ? AND nonce = ?")
      .bind(email, row.nonce)
      .run();
    return { ok: false, reason: "expired" };
  }
  const consumed = await db
    .prepare("UPDATE password_reset_codes SET code_hash = NULL WHERE email = ? AND nonce = ? AND code_hash = ?")
    .bind(email, row.nonce, row.code_hash)
    .run();
  return consumed.meta.changes === 1 ? { ok: true } : { ok: false, reason: "expired" };
}
