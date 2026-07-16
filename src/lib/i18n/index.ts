import { en } from "./en";
import { zhHant } from "./zh-hant";

export type MessageKey = keyof typeof en;
export type Locale = "en" | "zh-Hant";

export function getMessages(locale: Locale): Record<MessageKey, string> {
  if (locale === "zh-Hant") {
    return { ...en, ...zhHant } as Record<MessageKey, string>;
  }
  return { ...en } as Record<MessageKey, string>;
}

export function format(
  msg: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, key) => {
    return params[key] !== undefined ? String(params[key]) : `{${key}}`;
  });
}
