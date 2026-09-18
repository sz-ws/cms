"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useOptionalLocale } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n";
import { createDateFormatter, DEFAULT_TIME_ZONE, type DateFormatter } from "@/lib/datetime";

// 1.41.0:client 端的日期入口(規則見 lib/datetime.ts)。root layout 讀站台時區包在
// 最外層,後台與前台的 client component 都拿得到;server 先 render 的那一次與瀏覽器
// 算出同一個字串,不會對不上。

const TimeZoneContext = createContext<string | null>(null);

export function DateTimeProvider({ timeZone, children }: { timeZone: string; children: ReactNode }) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

/** 站台時區(IANA,如 "Asia/Taipei")。 */
export function useTimeZone(): string {
  return useContext(TimeZoneContext) ?? DEFAULT_TIME_ZONE;
}

/**
 * 站台時區的 formatter。locale 缺省用後台語言(有 I18nProvider 時),否則 en;
 * 前台插件可以直接指定,如 useDateFormatter("zh-Hant")。
 */
export function useDateFormatter(locale?: Locale): DateFormatter {
  const timeZone = useTimeZone();
  const contextLocale = useOptionalLocale();
  const resolved = locale ?? contextLocale ?? "en";
  return useMemo(() => createDateFormatter(resolved, timeZone), [resolved, timeZone]);
}

type Preset = "date" | "dateTime" | "time" | "monthDay";

/**
 * 站台時區的一段時間文字。server component 也能直接放(它是 client 元件,props 只有
 * 數字與字串),不必自己 await formatter:<DateTimeText at={order.createdAt} />。
 */
export function DateTimeText({
  at,
  preset = "dateTime",
  options,
  locale,
}: {
  at: number;
  preset?: Preset;
  /** 自訂 Intl 選項,優先於 preset。 */
  options?: Intl.DateTimeFormatOptions;
  locale?: Locale;
}) {
  const dates = useDateFormatter(locale);
  return <>{options ? dates.format(at, options) : dates[preset](at)}</>;
}
