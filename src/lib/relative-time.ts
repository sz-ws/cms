import type { Locale } from "@/lib/i18n";

// 完整字詞的相對時間("3 days ago" / 「3 天前」/ "just now" / 「剛剛」)。跟
// src/components/admin/dashboard/relative-time.ts 的縮寫格式("3d ago")故意分開——
// 那支是 dashboard 密集列表的語氣,這支給 /admin/account 的 prose 語境用。
// 給定 now 以求 SSR/CSR 一致:PasskeysManager 是 client component,但 now 由
// server(page.tsx)算好當 prop 傳入,不在 render 內呼叫 Date.now()(避免 hydration
// 對不上)。minute/hour/day 級距走 Intl.RelativeTimeFormat(numeric:"auto" 才有
// "yesterday" / 「昨天」),更久遠回落到當地慣例的日期。
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

function tag(locale: Locale): string {
  return locale === "zh-Hant" ? "zh-TW" : "en";
}

export function relativeTimeWords(
  epochMs: number,
  now: number,
  locale: Locale = "en",
): string {
  const diff = now - epochMs;
  if (!Number.isFinite(diff) || diff < MINUTE) {
    return locale === "zh-Hant" ? "剛剛" : "just now";
  }
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (diff < WEEK) return rtf.format(-Math.floor(diff / DAY), "day");
  return new Date(epochMs).toLocaleDateString(tag(locale) === "en" ? "en-US" : "zh-TW", {
    month: "short",
    day: "numeric",
    year: diff > YEAR ? "numeric" : undefined,
  });
}
