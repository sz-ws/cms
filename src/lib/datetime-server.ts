import { getSetting } from "@/lib/settings";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import { createDateFormatter, normalizeTimeZone, type DateFormatter } from "@/lib/datetime";

// 1.41.0:server 端的日期入口(規則見 lib/datetime.ts)。server component、route
// handler、CSV 匯出都從這裡拿 formatter —— 不要在 server 上直接 toLocaleString,
// 那是 UTC。

/** 站台時區(settings 的 core.timeZone;沒設或壞值時是台北)。 */
export async function getSiteTimeZone(): Promise<string> {
  return normalizeTimeZone(await getSetting<string>("core.timeZone"));
}

/** 站台時區的 formatter;locale 缺省用後台語言(core.locale)。 */
export async function getDateFormatter(locale?: Locale): Promise<DateFormatter> {
  const [timeZone, resolved] = await Promise.all([getSiteTimeZone(), locale ?? getLocale()]);
  return createDateFormatter(resolved, timeZone);
}
