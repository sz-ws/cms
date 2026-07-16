"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n/index";

// spec-extension-i18n.md §2.3:公開頁面(publicRoutes)沒有 core 的 I18nProvider,
// 故其 client 端不能靠 useT()/useLocale()(會 throw)。declarative FormView 在 admin
// 與 public 兩種 mode 都會拿到一個 `locale` prop(admin 由 FormViewPage server resolve、
// public 由 route 的 server wrapper resolve),於此把 locale 下放給整棵 field control 樹
// (LeafFieldControl / BlocksField / TextFullscreenEditor)——它們是「唯一會渲染 label
// 的巢狀 client 元件」,透過 context 取 locale 而不需逐層 prop-drill 進 FIELD_COMPONENTS。
//
// 缺 provider 時 useExtLocale() 回退 "en"(不 throw),讓任何在 FormView 樹外被單獨
// mount 的 field control 仍可運作。

const ExtLocaleContext = createContext<Locale>("en");

export function ExtLocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <ExtLocaleContext.Provider value={locale}>
      {children}
    </ExtLocaleContext.Provider>
  );
}

/** field control 樹取當前 locale(缺 provider → "en",public-safe)。 */
export function useExtLocale(): Locale {
  return useContext(ExtLocaleContext);
}
