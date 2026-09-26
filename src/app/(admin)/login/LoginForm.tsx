"use client";

import {
  startTransition,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { cn } from "@/lib/utils";
import { FaceIdIcon } from "@/components/ui/face-id-icon";
import { FirebaseSignInButton } from "@/components/auth/FirebaseSignInButton";
import { signInWithPasskey } from "@/components/auth/passkey-sign-in";
import type { FirebaseWebConfig } from "@/lib/oidc";
import { useT } from "@/lib/i18n/I18nProvider";
import { Field, PrimaryButton, TextButton } from "./LoginField";
import { ResetPasswordForm } from "./ResetPasswordForm";

// 05 §5:next = searchParams.next 僅當以 "/" 開頭、不以 "//" 開頭、且不含反斜線(防 open
// redirect —— 部分瀏覽器將 "\" 當 "/" 解析,"/\evil.com" 可能被當成 protocol-relative URL),
// 否則 /admin。
// useSyncExternalStore 的空訂閱:能力偵測是常數,不會變、不需要通知。
function subscribeNoop(): () => void {
  return () => {};
}

// 冷眼回報 2026-07-16:passkey 主 CTA 對「從沒註冊過 passkey」的新管理員是誤導 ——
// 必撞一次失敗才找到密碼欄。改成「記憶式對調」:哪種方式上次登入成功,哪種就當主 CTA。
// 只記成功,不記嘗試;OAuth 按鈕不記(次要方式,不參與主 CTA 對調)。
const LAST_LOGIN_KEY = "szws.lastLogin";
type LastLoginMethod = "password" | "passkey";

function readLastLogin(): LastLoginMethod | null {
  try {
    const v = window.localStorage.getItem(LAST_LOGIN_KEY);
    return v === "password" || v === "passkey" ? v : null;
  } catch {
    // 隱私模式 / storage 被封鎖 —— 純體驗優化,靜默降級為「未知」。
    return null;
  }
}

function writeLastLogin(method: LastLoginMethod): void {
  try {
    window.localStorage.setItem(LAST_LOGIN_KEY, method);
  } catch {
    // 同上,寫入失敗不影響登入本身。
  }
}

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return "/admin";
  return next;
}

// 登入頁渲染第三方登入按鈕所需的最小資料 —— 由 server 端 listLoginProviders()
// (src/lib/oidc.ts)產出;svg 已在 manifest 安裝時經 svg-guard 驗證,此處視為可信。
// kind "firebase"(1.54.0)不走導轉,按鈕在頁面上彈出 Firebase 登入(FirebaseSignInButton)。
export interface LoginProviderButton {
  id: string;
  kind?: "oidc" | "firebase";
  label: string;
  svg?: string;
  background?: string;
  foreground?: string;
  firebase?: FirebaseWebConfig;
}

// OAuth callback 以 /login?error=<code> 帶回機器可讀錯誤;未知 code 一律泛化。
function oauthErrorKey(code: string) {
  switch (code) {
    case "oauth_denied":
      return "login.error.oauthDenied" as const;
    case "oauth_state":
    case "oauth_stale":
      return "login.error.oauthState" as const;
    case "popup_blocked":
      return "login.error.popupBlocked" as const;
    case "not_linked":
      return "login.error.notLinked" as const;
    case "email_exists":
      return "login.error.emailExists" as const;
    default:
      return "login.error.oauthFailed" as const;
  }
}

export function LoginForm({
  next,
  siteTitle,
  providers = [],
  oauthError,
  resetAvailable = false,
}: {
  next?: string;
  siteTitle: string;
  providers?: LoginProviderButton[];
  oauthError?: string;
  /** 1.56.0:寄得出信 → 給「忘記密碼」;否則請他聯絡網站管理員。 */
  resetAvailable?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // OAuth redirect 帶回的錯誤只當「初始值」:使用者一開始新的登入嘗試就讓位。
  const [error, setError] = useState<string | null>(() =>
    oauthError ? t(oauthErrorKey(oauthError)) : null,
  );
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  // client-only 能力偵測:server snapshot 給 null(SSR/hydration 一致),client 端
  // 直接讀 browserSupportsWebAuthn()(常數,不需訂閱)。取代先前 effect+setState 寫法。
  const supportsPasskey = useSyncExternalStore(
    subscribeNoop,
    browserSupportsWebAuthn,
    () => null,
  );
  // 同一招用在「上次用哪種方式登入」:SSR/初始 hydration 一律拿不到 localStorage
  // (getServerSnapshot 給 null),此時 passkeyPrimary 為 false —— 安全預設是密碼主。
  const lastLogin = useSyncExternalStore(subscribeNoop, readLastLogin, () => null);
  const [showOther, setShowOther] = useState(false);
  const [resetting, setResetting] = useState(false);
  // 進頁自動跑一次 usernameless passkey(discoverable credential)。ref 同步擋掉
  // StrictMode 的雙重 effect,不然兩個 WebAuthn ceremony 疊在一起會互相 abort。
  const autoTried = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        writeLastLogin("password");
        startTransition(() => {
          router.push(safeNext(next));
        });
        return;
      }
      if (res.status === 429) setError(t("login.error.rateLimit"));
      else setError(t("login.error.invalidCredentials"));
    } catch {
      setError(t("login.error.network"));
    } finally {
      setPending(false);
    }
  }

  // L1 §5:passkey 登入(流程在 components/auth/passkey-sign-in.ts)。
  // auto = 進頁自動觸發的那一次:ceremony 被取消/無 credential 時保持安靜,
  // 不對「只是想用密碼登入」的人噴錯誤;但 ceremony 完成而 verify 失敗仍要講。
  async function onPasskey(auto = false) {
    setError(null);
    setPasskeyPending(true);
    try {
      const result = await signInWithPasskey();
      if (result === "ok") {
        writeLastLogin("passkey");
        startTransition(() => {
          router.push(safeNext(next));
        });
        return;
      }
      if (result === "cancelled") {
        // 使用者取消 / 無可用 credential / 網路錯誤 —— 一律泛化訊息。
        if (!auto) setError(t("login.error.passkeyCancelled"));
        return;
      }
      setError(t(result === "rate_limited" ? "login.error.passkeyRateLimit" : "login.error.passkeyFailed"));
    } finally {
      setPasskeyPending(false);
    }
  }

  useEffect(() => {
    if (browserSupportsWebAuthn() && !autoTried.current) {
      autoTried.current = true;
      void onPasskey(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only auto attempt
  }, []);

  const passwordForm = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field
        id="email"
        label={t("login.email")}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
        placeholder="you@domain.com"
      />
      <Field
        id="password"
        label={t("login.password")}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        placeholder="••••••••"
      />
      <PrimaryButton pending={pending} label={t("login.signIn")} pendingLabel={t("login.signingIn")} />
      {resetAvailable ? (
        <TextButton
          onClick={() => {
            setError(null);
            setResetting(true);
          }}
        >
          {t("login.forgot")}
        </TextButton>
      ) : (
        <p className="text-[13px] text-black/45">{t("login.forgotContact")}</p>
      )}
    </form>
  );

  const showPasskey = supportsPasskey === true;
  // 記憶式對調:只有「上次成功用 passkey 登入過」才讓 passkey 當主 CTA;首次
  // 到訪(lastLogin 為 null,還沒任何一次成功登入)一律密碼主 —— 新管理員通常
  // 沒註冊 passkey,逼他們先撞一次失敗才找到密碼欄不合理。
  const passkeyPrimary = showPasskey && lastLogin === "passkey";

  const passkeySecondaryButton = showPasskey && !passkeyPrimary && (
    <button
      type="button"
      onClick={() => void onPasskey()}
      disabled={passkeyPending}
      className={cn(
        "flex h-10 items-center justify-center gap-2 rounded-[8px] px-3.5 text-[14px] font-medium text-black/80",
        "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[filter,transform] duration-150 ease-out",
        "hover:brightness-[0.97] active:scale-[0.96]",
        "focus-visible:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_0_0_3px_rgba(0,0,0,0.1)] focus-visible:outline-none",
        passkeyPending && "cursor-wait opacity-60",
      )}
    >
      <FaceIdIcon className="size-[18px] text-black/55" />
      <span>{passkeyPending ? t("login.signingIn") : t("login.usePasskey")}</span>
    </button>
  );

  return (
    // concentric shell: 20px outer − 6px padding = 14px inner card
    <div className="w-full max-w-[22.5rem] rounded-[20px] bg-white/55 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)] backdrop-blur-md">
      <div className="rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <div className="px-6 pt-6 pb-5">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
            {siteTitle}
          </h1>
          <p className="mt-0.5 text-[13px] text-black/45">
            {t("login.signInToAdmin")}
          </p>
        </div>

        {resetting ? (
          <div className="px-6 pb-6">
            <ResetPasswordForm next={next} initialEmail={email} onBack={() => setResetting(false)} />
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-6 pb-6">
            {passkeyPrimary && (
              <button
                type="button"
                onClick={() => void onPasskey()}
                disabled={passkeyPending}
                className={cn(
                  "flex h-10 items-center justify-center gap-2 rounded-[8px] bg-black px-3.5 text-[14px] font-medium text-white",
                  "transition-[background-color,transform] duration-150 ease-out",
                  "hover:bg-black/85 active:scale-[0.96]",
                  "focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none",
                  passkeyPending && "cursor-wait opacity-60",
                )}
              >
                <FaceIdIcon className="size-[18px] text-white/85" />
                <span>{passkeyPending ? t("login.signingIn") : t("login.usePasskey")}</span>
              </button>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-[8px] border border-red-600/15 bg-red-50 px-3 py-2 text-[13px] text-red-700"
              >
                {error}
              </p>
            )}

            {passkeyPrimary ? (
              <div>
                <div className="flex items-center gap-3">
                  <span aria-hidden className="h-px flex-1 bg-black/[0.08]" />
                  <button
                    type="button"
                    onClick={() => setShowOther((v) => !v)}
                    aria-expanded={showOther}
                    className="flex cursor-pointer items-center gap-1 text-[13px] text-black/45 transition-colors select-none hover:text-black/70"
                  >
                    {t("login.otherMethods")}
                    <motion.span
                      aria-hidden
                      animate={{ rotate: showOther ? 180 : 0 }}
                      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                      className="inline-flex"
                    >
                      <svg
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-3"
                      >
                        <path d="M3 4.5 6 7.5 9 4.5" />
                      </svg>
                    </motion.span>
                  </button>
                  <span aria-hidden className="h-px flex-1 bg-black/[0.08]" />
                </div>
                <AnimatePresence initial={false}>
                  {showOther && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ type: "spring", duration: 0.35, bounce: 0 }}
                      className="overflow-hidden"
                    >
                      {/* 內距放在內層:height 動畫夾住 margin 會跳,padding 一起被夾就順 */}
                      <div className="pt-4 pb-0.5">{passwordForm}</div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              passwordForm
            )}

            {(passkeySecondaryButton || providers.length > 0) && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span aria-hidden className="h-px flex-1 bg-black/[0.08]" />
                  <span className="text-[12px] text-black/40 select-none">
                    {t("login.orContinueWith")}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-black/[0.08]" />
                </div>
                <div className="flex flex-col gap-2">
                  {passkeySecondaryButton}
                  {providers.map((p) => {
                    const className = cn(
                      "flex h-10 items-center justify-center gap-2 rounded-[8px] px-3.5 text-[14px] font-medium",
                      "shadow-[0_0_0_1px_rgba(0,0,0,0.08)] transition-[filter,transform] duration-150 ease-out",
                      "hover:brightness-[0.97] active:scale-[0.96] disabled:opacity-60",
                      "focus-visible:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_0_0_3px_rgba(0,0,0,0.1)] focus-visible:outline-none",
                    );
                    const style = {
                      background: p.background ?? "#ffffff",
                      color: p.foreground ?? "rgba(0,0,0,0.85)",
                    };
                    const content = (
                      <>
                        {p.svg && (
                          <span
                            aria-hidden
                            className="inline-flex [&>svg]:size-[18px]"
                            // 安裝時已過 svg-guard(allowlist 驗證),渲染端視為可信。
                            dangerouslySetInnerHTML={{ __html: p.svg }}
                          />
                        )}
                        <span>{p.label}</span>
                      </>
                    );
                    if (p.kind === "firebase" && p.firebase) {
                      return (
                        <FirebaseSignInButton
                          key={p.id}
                          providerId={p.id}
                          config={p.firebase}
                          next={safeNext(next)}
                          className={className}
                          style={style}
                          onError={(code) => setError(code ? t(oauthErrorKey(code)) : null)}
                        >
                          {content}
                        </FirebaseSignInButton>
                      );
                    }
                    return (
                      <a
                        key={p.id}
                        href={`/api/auth/oauth/${encodeURIComponent(p.id)}/start?next=${encodeURIComponent(safeNext(next))}`}
                        className={className}
                        style={style}
                      >
                        {content}
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <p className="px-4 pt-2 pb-1 text-center text-[11.5px] text-black/35">
        {t("login.sessionBased")}
      </p>
    </div>
  );
}
