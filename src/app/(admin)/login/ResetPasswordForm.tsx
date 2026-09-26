"use client";

import { useEffect, useState } from "react";
import { continueUrl } from "@/lib/sign-in-continue";
import { useT } from "@/lib/i18n/I18nProvider";
import { Field, PrimaryButton, TextButton } from "./LoginField";

// 1.56.0:忘記密碼(API 在 /api/auth/password-reset 與 /confirm,規則在 src/lib/password-reset.ts)。
// 兩步:Email → 驗證碼 + 新密碼。成功後伺服器已經登入,整頁導到 /api/auth/continue 依身分分流
// (後台人員進 next 或 /admin,會員回前台)。

type T = ReturnType<typeof useT>;
type ErrorBody = { error?: string; retryIn?: number; attemptsLeft?: number };

function errorText(t: T, body: ErrorBody | null, status: number): string {
  switch (body?.error) {
    case "invalid_email":
      return t("reset.error.invalidEmail");
    case "email_unavailable":
      return t("reset.error.unavailable");
    case "cooldown":
      return t("reset.error.cooldown", { n: body.retryIn ?? 60 });
    case "code_wrong":
      return t("reset.error.codeWrong", { n: body.attemptsLeft ?? 0 });
    case "code_expired":
      return t("reset.error.codeExpired");
    case "weak_password":
      return t("reset.error.weakPassword");
    case "staff_reset_off":
      return t("reset.error.staffOff");
    default:
      return status === 429 ? t("login.error.rateLimit") : t("login.error.network");
  }
}

async function post(url: string, payload: unknown): Promise<{ ok: boolean; status: number; body: ErrorBody | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  return { ok: res.ok, status: res.status, body };
}

/** 距離可以重寄還有幾秒;每秒更新一次(interval 的 callback 裡 setState,不在 effect 本體)。 */
function useSecondsUntil(target: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (target === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [target]);
  return target === null ? 0 : Math.max(0, Math.ceil((target - now) / 1000));
}

export function ResetPasswordForm({
  next,
  initialEmail,
  onBack,
}: {
  next?: string;
  initialEmail: string;
  onBack: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const waitSeconds = useSecondsUntil(resendAt);

  async function sendCode(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const res = await post("/api/auth/password-reset", { email });
      if (res.ok) {
        const resendIn = (res.body as { resendIn?: number } | null)?.resendIn ?? 60;
        setResendAt(Date.now() + resendIn * 1000);
        setStep("code");
        return;
      }
      // 冷卻中代表剛寄過一組:直接到輸入驗證碼那一步。
      if (res.body?.error === "cooldown") {
        setResendAt(Date.now() + (res.body.retryIn ?? 60) * 1000);
        setStep("code");
      }
      setError(errorText(t, res.body, res.status));
    } catch {
      setError(t("login.error.network"));
    } finally {
      setPending(false);
    }
  }

  async function confirm(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const res = await post("/api/auth/password-reset/confirm", { email, code, password });
      if (res.ok) {
        window.location.assign(continueUrl(next, null));
        return;
      }
      setError(errorText(t, res.body, res.status));
      setPending(false);
    } catch {
      setError(t("login.error.network"));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-black/85">{t("reset.title")}</h2>
        <p className="mt-0.5 text-[13px] text-black/45">
          {step === "email" ? t("reset.lede") : t("reset.sent", { email })}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
        >
          {error}
        </p>
      )}

      {step === "email" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
          className="flex flex-col gap-4"
        >
          <Field
            id="reset-email"
            label={t("login.email")}
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="username"
            inputMode="email"
            placeholder="you@domain.com"
          />
          <PrimaryButton pending={pending} label={t("reset.send")} pendingLabel={t("reset.sending")} />
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
          className="flex flex-col gap-4"
        >
          {/* 讓密碼管理器把新密碼存在對的帳號底下。 */}
          <input type="email" value={email} autoComplete="username" readOnly hidden />
          <Field
            id="reset-code"
            label={t("reset.code")}
            type="text"
            value={code}
            onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            placeholder="123456"
          />
          <Field
            id="reset-password"
            label={t("reset.newPassword")}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            hint={t("reset.passwordHint")}
          />
          <PrimaryButton pending={pending} label={t("reset.submit")} pendingLabel={t("reset.saving")} />
          <TextButton onClick={() => void sendCode()} disabled={pending || waitSeconds > 0}>
            {waitSeconds > 0 ? t("reset.resendIn", { n: waitSeconds }) : t("reset.resend")}
          </TextButton>
        </form>
      )}

      <TextButton onClick={onBack}>{t("reset.back")}</TextButton>
    </div>
  );
}
