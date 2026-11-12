"use client";

import { useEffect, useSyncExternalStore } from "react";
import { hasSignedInHint } from "@/lib/signed-in-hint";
import { decideLoginEntry } from "./login-entry";
import { LoginScreen } from "./LoginScreen";
import type { LoginProviderButton } from "./LoginForm";

// 2.0:存起來的 /login 在瀏覽器裡決定這位訪客要看什麼(規則見 ./login-entry.ts)。
//
// 伺服器 render(也就是存起來的 HTML)不知道網址與 cookie:畫一張沒有參數的表單,訪客馬上看得到;
// 一定會轉走的頁(還沒有人、插件的登入頁)什麼都不畫,免得表單閃一下。hydrate 之後讀網址與 cookie。

function subscribeNoop(): () => void {
  return () => {};
}
const readSearch = () => window.location.search;
const readHint = () => hasSignedInHint(document.cookie);

// 登入提示在、session 卻不在的時候,/api/auth/continue 會清掉提示再送回這裡。萬一清不掉就會來回轉:
// 同一個分頁 10 秒內只交給伺服器一次,第二次留在表單。
const CONTINUE_TRIED_KEY = "szws.login.continueTried";
function mayAskServer(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(CONTINUE_TRIED_KEY) ?? 0);
    if (Date.now() - last < 10_000) return false;
    window.sessionStorage.setItem(CONTINUE_TRIED_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export function LoginEntry({
  siteTitle,
  signInPage,
  needsSetup,
  providers,
  resetAvailable,
}: {
  siteTitle: string;
  signInPage: string | null;
  needsSetup: boolean;
  providers: LoginProviderButton[];
  resetAvailable: boolean;
}) {
  // server snapshot = null:存起來的 HTML 與 hydration 都是「還不知道」,之後才換成真的值。
  const search = useSyncExternalStore(subscribeNoop, readSearch, () => null);
  const hint = useSyncExternalStore(subscribeNoop, readHint, () => false);
  const decision =
    search === null ? null : decideLoginEntry({ search, signInPage, signedInHint: hint, needsSetup });
  const kind = decision?.kind ?? null;
  const href = decision && decision.kind !== "form" ? decision.href : null;

  useEffect(() => {
    if (!href) return;
    if (kind === "go" || (kind === "signed-in" && mayAskServer())) window.location.replace(href);
  }, [kind, href]);

  // 一定會轉走的頁不畫表單:還沒有人、或有插件的登入頁而網址不是 ?form=1(還不知道網址時也不畫)。
  if (needsSetup || (signInPage && kind !== "form" && kind !== "signed-in")) return null;
  const form = decision?.kind === "form" ? decision : null;
  return (
    <LoginScreen
      siteTitle={siteTitle}
      next={form?.next}
      oauthError={form?.oauthError}
      providers={providers}
      resetAvailable={resetAvailable}
      // 確定留在這頁才自動試 Passkey:要轉走的訪客不該先跳出 Passkey 視窗。
      autoPasskey={form !== null}
    />
  );
}
