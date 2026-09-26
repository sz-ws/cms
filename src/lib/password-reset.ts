import { getCloudflareContext } from "@opennextjs/cloudflare";
import { hashPassword } from "./auth";
import { markEmailVerified } from "./login-accounts";
import { clearLoginFailures, hitRateLimit } from "./rate-limit";
import { getSetting } from "./settings";
import { checkCode, cooldownRemaining, issueCode, RESEND_AFTER_MS, withdrawCode } from "./password-reset-codes";
import { passwordChangedMail, resetCodeMail, staffResetOffMail, type ResetMail } from "./password-reset-mail";
import type { Locale } from "./i18n";

// 1.56.0:忘記密碼(後台人員與會員都能用),在 core 的登入表單(/login?form=1,以及沒有插件
// 登入頁時的 /login)。流程:Email → 寄 6 位數驗證碼 → 驗證碼 + 新密碼 → 換掉密碼、登出
// 所有裝置、在這裡登入、寄一封「密碼已變更」。驗證碼本身在 password-reset-codes.ts。
//
// 帳號列舉:申請的回應與冷卻不管有沒有這個帳號都一樣 —— 每個 Email 都寫一列碼、都算
// 額度;查帳號、決定寄什麼、寄信全部在回應之後做(waitUntil),連回應時間都分不出來。
//   - 會員,或允許重設的後台人員:寄驗證碼。
//   - 後台人員但站台關掉了「後台人員可用 Email 重設密碼」:寄一封「請聯絡網站管理員」,
//     不寄碼(信只到信箱主人手上,不洩漏給申請的人)。
//   - 沒有帳號:什麼都不寄(不替陌生信箱製造垃圾信)。碼存著也沒用:確認時對不到帳號。
//
// 限速:申請每個 Email 每小時 5 封、每個 IP 每小時 20 封;確認每個 IP 15 分鐘 30 次;
// 同一組碼最多試 5 次。

export const STAFF_RESET_SETTING = "core.auth.staffPasswordReset";

const HOUR = 60 * 60_000;
const QUARTER = 15 * 60_000;

export const RESET_LIMITS = {
  requestPerEmail: { namespace: "pw-reset-email", limit: 5, windowMs: HOUR },
  requestPerIp: { namespace: "pw-reset-ip", limit: 20, windowMs: HOUR },
  confirmPerIp: { namespace: "pw-reset-confirm-ip", limit: 30, windowMs: QUARTER },
} as const;

/** 和建立使用者一樣至少 8 個字元;上限只為了限制雜湊的輸入。 */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

type ResetAccount =
  | { kind: "none" }
  | { kind: "member" | "staff"; id: string; email: string };

/** 自訂角色的 users.role 也是 "guest"(migrations/0021),所以一定要看 staff_role_id。 */
async function findResetAccount(db: D1Database, email: string): Promise<ResetAccount> {
  const row = await db
    .prepare("SELECT id, email, role, staff_role_id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; role: string; staff_role_id: string | null }>();
  if (!row) return { kind: "none" };
  const staff = row.role !== "guest" || row.staff_role_id !== null;
  return { kind: staff ? "staff" : "member", id: row.id, email: row.email };
}

/** 後台人員能不能用 Email 重設密碼(預設可以);會員一律可以。 */
async function staffResetAllowed(): Promise<boolean> {
  return (await getSetting<unknown>(STAFF_RESET_SETTING, true)) !== false;
}

/**
 * 回應之後才做的事(寄信)。Worker 上交給 waitUntil;拿不到 Cloudflare context(測試、
 * 非 Worker 環境)就直接等它做完。task 自己要接住所有錯。
 */
export async function afterResponse(task: Promise<void>): Promise<void> {
  try {
    getCloudflareContext().ctx.waitUntil(task);
  } catch {
    await task;
  }
}

async function send(mail: ResetMail): Promise<boolean> {
  const { sendEmail } = await import("./email");
  const result = await sendEmail(mail);
  if (!result.ok) console.error("[password-reset] sending mail failed", result.error);
  return result.ok;
}

async function siteName(): Promise<string> {
  const title = await getSetting<string>("core.siteTitle", "");
  return typeof title === "string" ? title.trim() : "";
}

/** 申請之後(回應之後):看帳號決定寄驗證碼、寄「請聯絡管理員」,或什麼都不寄。 */
async function deliverRequest(
  db: D1Database,
  email: string,
  issued: { code: string; nonce: string },
  locale: Locale,
): Promise<void> {
  try {
    const account = await findResetAccount(db, email);
    if (account.kind === "none") return;
    const site = await siteName();
    const allowed = account.kind === "member" || (await staffResetAllowed());
    const mail = allowed
      ? resetCodeMail(email, issued.code, locale, site)
      : staffResetOffMail(email, locale, site);
    if (!(await send(mail))) await withdrawCode(db, email, issued.nonce);
  } catch (error) {
    console.error("[password-reset] request follow-up failed", error instanceof Error ? error.name : "error");
  }
}

export type RequestResult =
  | { ok: true; resendIn: number }
  | { ok: false; status: 429; error: "cooldown"; retryIn: number }
  | { ok: false; status: 429; error: "rate_limited" };

const seconds = (ms: number) => Math.ceil(ms / 1000);

/** 申請一組驗證碼。呼叫端先確認寄得出信(emailReady)。 */
export async function requestPasswordReset(
  db: D1Database,
  input: { email: string; ip: string; locale: Locale },
  now: number,
): Promise<RequestResult> {
  const { email, ip, locale } = input;
  if (await hitRateLimit(ip, RESET_LIMITS.requestPerIp)) return { ok: false, status: 429, error: "rate_limited" };
  // 冷卻中先擋,不佔這個 Email 每小時的額度,也不動到手上那組還有效的碼。
  const waiting = await cooldownRemaining(db, email, now);
  if (waiting > 0) return { ok: false, status: 429, error: "cooldown", retryIn: seconds(waiting) };
  if (await hitRateLimit(email, RESET_LIMITS.requestPerEmail)) return { ok: false, status: 429, error: "rate_limited" };

  const issued = await issueCode(db, email, now);
  if (!issued.ok) return { ok: false, status: 429, error: "cooldown", retryIn: seconds(issued.retryInMs) };
  await afterResponse(deliverRequest(db, email, issued, locale));
  return { ok: true, resendIn: seconds(RESEND_AFTER_MS) };
}

export type ConfirmResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 400; error: "weak_password" | "code_expired" }
  | { ok: false; status: 400; error: "code_wrong"; attemptsLeft: number }
  | { ok: false; status: 403; error: "staff_reset_off" }
  | { ok: false; status: 429; error: "rate_limited" };

/** 換掉密碼並登出所有裝置(同一個 batch,不會只做一半)。 */
async function replacePassword(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ]);
}

/**
 * 驗證碼 + 新密碼。成功:換密碼、刪掉這個人所有的 session、記下 Email 已驗證、清掉登入
 * 失敗計數。建新 session、設 cookie、auth:signed-in 與「密碼已變更」通知由 route 做。
 */
export async function confirmPasswordReset(
  db: D1Database,
  input: { email: string; code: string; password: string; ip: string },
  now: number,
): Promise<ConfirmResult> {
  const { email, code, password, ip } = input;
  // 密碼不合格不用掉一次嘗試。
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { ok: false, status: 400, error: "weak_password" };
  }
  if (await hitRateLimit(ip, RESET_LIMITS.confirmPerIp)) return { ok: false, status: 429, error: "rate_limited" };

  const checked = await checkCode(db, email, code, now);
  if (!checked.ok) {
    return checked.reason === "wrong"
      ? { ok: false, status: 400, error: "code_wrong", attemptsLeft: checked.attemptsLeft }
      : { ok: false, status: 400, error: "code_expired" };
  }
  const account = await findResetAccount(db, email);
  // 沒有帳號就不會寄出碼;走到這裡代表帳號在寄碼之後被刪了。
  if (account.kind === "none") return { ok: false, status: 400, error: "code_expired" };
  if (account.kind === "staff" && !(await staffResetAllowed())) {
    return { ok: false, status: 403, error: "staff_reset_off" };
  }
  await replacePassword(db, account.id, await hashPassword(password));
  await markEmailVerified(account.id);
  await clearLoginFailures(email);
  return { ok: true, userId: account.id, email: account.email };
}

/** 成功之後(回應之後):寄「密碼已變更」給帳號的信箱。 */
export async function notifyPasswordChanged(email: string, locale: Locale): Promise<void> {
  try {
    await send(passwordChangedMail(email, locale, await siteName()));
  } catch (error) {
    console.error("[password-reset] notice failed", error instanceof Error ? error.name : "error");
  }
}
