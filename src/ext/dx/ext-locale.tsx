"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Locale, MessageKey } from "@/lib/i18n/index";
import { format, getMessages } from "@/lib/i18n/index";
import { useOptionalLocale } from "@/lib/i18n/I18nProvider";

// spec-extension-i18n.md §2.3:公開頁面(publicRoutes)沒有 core 的 I18nProvider,
// 故其 client 端不能靠 useT()/useLocale()(會 throw)。declarative FormView 在 admin
// 與 public 兩種 mode 都會拿到一個 `locale` prop(admin 由 FormViewPage server resolve、
// public 由 route 的 server wrapper resolve),於此把 locale 下放給整棵 field control 樹
// (LeafFieldControl / BlocksField / TextFullscreenEditor)——它們是「唯一會渲染 label
// 的巢狀 client 元件」,透過 context 取 locale 而不需逐層 prop-drill 進 FIELD_COMPONENTS。
//
// 缺 provider 時 useExtLocale() 先退到 core 的 I18nProvider(後台其他地方單獨 mount 的
// field control,例如 blog 版面裡的 RichtextEditor),兩個都沒有才是 "en"(不 throw)。

const ExtLocaleContext = createContext<Locale | null>(null);

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

/** field control 樹取當前 locale(缺 provider → 後台 locale → "en",public-safe)。 */
export function useExtLocale(): Locale {
  const ext = useContext(ExtLocaleContext);
  const app = useOptionalLocale();
  return ext ?? app ?? "en";
}

// getMessages 每次都合併一整份字典;field control 每次 render 都會取,所以按 locale 快取。
const dictionaries = new Map<Locale, Record<MessageKey, string>>();

function dictionaryFor(locale: Locale): Record<MessageKey, string> {
  let messages = dictionaries.get(locale);
  if (!messages) {
    messages = getMessages(locale);
    dictionaries.set(locale, messages);
  }
  return messages;
}

type ExtTranslate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * field control 樹的 t():和 useT() 同一份 core 字典,但 locale 走 useExtLocale(),
 * 所以公開表單(沒有 I18nProvider)也能用。
 */
export function useExtT(): ExtTranslate {
  const messages = dictionaryFor(useExtLocale());
  return (key, params) => format(messages[key] ?? key, params);
}
