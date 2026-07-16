import type { Locale } from "./index";

export { getMessages, type MessageKey, type Locale } from "./index";

export async function getLocale(): Promise<Locale> {
  const { getSetting } = await import("@/lib/settings");
  const locale = await getSetting<string>("core.locale", "en");
  if (locale === "zh-Hant") return "zh-Hant";
  return "en";
}
