import { getDB } from "./cf";

// 04 §5:Login rate limit(D1 實作,無新依賴)。
// key = `ip:<CF-Connecting-IP>` 與 `email:<email>` 各一筆。
// 15 分鐘窗口內同 key 失敗 ≥ 10 次 → 429。
// 計數遞增必須是單一 statement(先讀後寫會有並發 race)。

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

/**
 * 記一次失敗並回傳「記完後是否已達上限」。
 * 單一 statement:過窗(window_start 太舊)則同時 reset count=1、window_start=now;
 * 否則 count = count + 1。原子完成,無 read-then-write race。
 * windowMs 為呼叫端指定的窗口長度(login 用 WINDOW_MS;其他 namespace 可帶自己的)。
 */
async function recordFailure(
  key: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const windowFloor = now - windowMs;
  // ON CONFLICT:若上一次 window_start 已過窗 → reset;否則遞增。
  await getDB()
    .prepare(
      `INSERT INTO login_attempts (key, count, window_start)
       VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN login_attempts.window_start < ?3 THEN 1 ELSE login_attempts.count + 1 END,
         window_start = CASE WHEN login_attempts.window_start < ?3 THEN ?2 ELSE login_attempts.window_start END`,
    )
    .bind(key, now, windowFloor)
    .run();
  const row = await getDB()
    .prepare(`SELECT count FROM login_attempts WHERE key = ?1`)
    .bind(key)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** 讀目前計數(不遞增);過窗視為 0。windowMs 同 recordFailure。 */
async function currentCount(
  key: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const row = await getDB()
    .prepare(`SELECT count, window_start FROM login_attempts WHERE key = ?1`)
    .bind(key)
    .first<{ count: number; window_start: number }>();
  if (!row) return 0;
  if (row.window_start < now - windowMs) return 0;
  return row.count;
}

/** login 前檢查:任一 key(ip / email)已達上限 → true(擋下,回 429)。 */
export async function isRateLimited(
  ip: string,
  email: string,
): Promise<boolean> {
  const now = Date.now();
  const [ipCount, emailCount] = await Promise.all([
    currentCount(`ip:${ip}`, now, WINDOW_MS),
    currentCount(`email:${email}`, now, WINDOW_MS),
  ]);
  return ipCount >= MAX_ATTEMPTS || emailCount >= MAX_ATTEMPTS;
}

/** 登入失敗:對 ip 與 email 兩個 key 各記一次。 */
export async function recordLoginFailure(
  ip: string,
  email: string,
): Promise<void> {
  const now = Date.now();
  await Promise.all([
    recordFailure(`ip:${ip}`, now, WINDOW_MS),
    recordFailure(`email:${email}`, now, WINDOW_MS),
  ]);
}

/** 成功登入:清除該 email 的計數(04 §5)。 */
export async function clearLoginFailures(email: string): Promise<void> {
  await getDB()
    .prepare(`DELETE FROM login_attempts WHERE key = ?1`)
    .bind(`email:${email}`)
    .run();
}

// Phase E §4:generic rate limit, reusing the same `login_attempts` D1 counter
// (it's just a key/count/window_start table — nothing login-specific about the
// storage). Every non-login caller MUST pass a distinct `namespace` so its keys
// can never collide with login's own `ip:`/`email:` keys or with another
// caller's namespace (e.g. "media-upload", "registry-install", "callback").
// This is purely additive: isRateLimited/recordLoginFailure/clearLoginFailures
// above are untouched, so the login route needs no changes.

export interface RateLimitOptions {
  /** Distinct per-caller prefix, e.g. "media-upload". Keeps keys isolated. */
  namespace: string;
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Record one hit for `id` under `namespace` and report whether the caller
 * should be rejected (count after recording > limit). Single atomic upsert via
 * recordFailure, so concurrent requests can't race past the limit.
 */
export async function hitRateLimit(
  id: string,
  opts: RateLimitOptions,
): Promise<boolean> {
  const now = Date.now();
  const key = `${opts.namespace}:${id}`;
  const count = await recordFailure(key, now, opts.windowMs);
  return count > opts.limit;
}
