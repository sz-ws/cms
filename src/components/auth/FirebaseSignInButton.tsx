"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Auth } from "firebase/auth";
import type { FirebaseWebConfig } from "@/lib/oidc";

// Firebase 登入按鈕(1.54.0)。後台登入頁、帳號頁、會員插件的 <MemberAccess> 共用。
//
// 畫出來時就在背景載入 Firebase SDK 並暖好 Auth;按下時在同一個點擊裡開登入視窗,拿到
// ID token 交給 /api/auth/firebase/<id>,伺服器設好 session cookie 後換到它給的頁面。
// 外觀由呼叫端決定(className/style/children);錯誤碼交給 onError,由呼叫端顯示。

type ClientModule = typeof import("./firebase-client");

export interface FirebaseSignInButtonProps {
  providerId: string;
  config: FirebaseWebConfig;
  mode?: "login" | "link";
  /** 登入後去哪(站內路徑)。 */
  next?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** 失敗碼(oauth_failed、email_exists、popup_blocked…);重新嘗試時以 null 清掉。 */
  onError?: (code: string | null) => void;
}

/** 伺服器拒絕(帶我們自己的錯誤碼)。 */
class ExchangeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 錯誤 → 錯誤碼;null = 使用者自己關掉視窗,不算錯。 */
function errorCode(e: unknown): string | null {
  if (e instanceof ExchangeError) return e.code;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return null;
  if (code === "auth/popup-blocked") return "popup_blocked";
  return "oauth_failed";
}

export function FirebaseSignInButton({
  providerId,
  config,
  mode = "login",
  next,
  className,
  style,
  children,
  onError,
}: FirebaseSignInButtonProps) {
  const ready = useRef<{ mod: ClientModule; auth: Auth } | null>(null);
  const [busy, setBusy] = useState(false);
  const { apiKey, authDomain, projectId, signIn } = config;

  useEffect(() => {
    let live = true;
    import("./firebase-client")
      .then((mod) => {
        if (live) ready.current = { mod, auth: mod.prepareAuth({ apiKey, authDomain, projectId, signIn }) };
      })
      .catch(() => undefined); // 載不到:按下時再試一次,失敗就顯示錯誤
    return () => {
      live = false;
    };
  }, [apiKey, authDomain, projectId, signIn]);

  async function exchange(idToken: string): Promise<void> {
    const res = await fetch(`/api/auth/firebase/${encodeURIComponent(providerId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken, mode, next }),
    });
    const data = (await res.json().catch(() => ({}))) as { location?: unknown; error?: unknown };
    if (res.ok && typeof data.location === "string") {
      window.location.assign(data.location);
      return;
    }
    throw new ExchangeError(typeof data.error === "string" ? data.error : "oauth_failed");
  }

  function onClick() {
    if (busy) return;
    onError?.(null);
    setBusy(true);
    // SDK 已經載好:在這個點擊裡直接開視窗。還沒載好(很少見):等它,視窗可能被擋。
    const loaded = ready.current;
    const token = loaded
      ? loaded.mod.popupIdToken(loaded.auth, signIn)
      : import("./firebase-client").then((mod) =>
          mod.popupIdToken(mod.prepareAuth(config), signIn),
        );
    token.then(exchange).catch((e: unknown) => {
      setBusy(false);
      const code = errorCode(e);
      if (code) onError?.(code);
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className={className}
      style={style}
    >
      {children}
    </button>
  );
}
