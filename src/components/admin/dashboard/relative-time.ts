import type { Locale } from "@/lib/i18n";

// Compact relative time ("just now", "5m ago", "3h ago", "2d ago", "Mar 4").
// Pure + deterministic given `now` so it renders identically on the server
// (this is a server component surface — no client clock drift concern).
// zh-Hant 沒有 "5m" 的縮寫慣例,走 Intl 的「5 分鐘前」;日期回落當地格式。

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(
  epochMs: number,
  now: number = Date.now(),
  locale: Locale = "en",
): string {
  const diff = now - epochMs;
  if (!Number.isFinite(diff)) return "";
  if (locale === "zh-Hant") {
    if (diff < MINUTE) return "剛剛";
    const rtf = new Intl.RelativeTimeFormat("zh-TW", { numeric: "always" });
    if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
    if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), "hour");
    if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), "day");
    return new Date(epochMs).toLocaleDateString("zh-TW", {
      month: "short",
      day: "numeric",
    });
  }
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(epochMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
