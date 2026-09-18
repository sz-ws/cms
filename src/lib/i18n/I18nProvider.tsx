"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { MessageKey, Locale } from "./index";
import { format } from "./index";

interface I18nContextValue {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface I18nProviderProps {
  locale: Locale;
  messages: Record<MessageKey, string>;
  children: ReactNode;
}

export function I18nProvider({ locale, messages, children }: I18nProviderProps) {
  const t = (key: MessageKey, params?: Record<string, string | number>) => {
    return format(messages[key] ?? key, params);
  };

  return (
    <I18nContext.Provider value={{ locale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT(): (key: MessageKey, params?: Record<string, string | number>) => string {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useT must be used within I18nProvider");
  }
  return ctx.t;
}

/**
 * 1.40.0:後台與前台都會出現的元件用(如 <StatusBadge>):不在 I18nProvider 裡時回 null,
 * 呼叫端自己決定退路,不像 useT 直接丟錯。
 */
export function useOptionalT(): I18nContextValue["t"] | null {
  return useContext(I18nContext)?.t ?? null;
}

/** 給非字典的 locale-aware 格式化(相對時間、日期)用。 */
export function useLocale(): Locale {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useLocale must be used within I18nProvider");
  }
  return ctx.locale;
}
