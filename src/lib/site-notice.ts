import { createDateFormatter } from "./datetime";

// 1.56.0:網站公告(前台最上方的一行字)。這個檔是純函式 —— 設定頁的欄位驗證
// (setting-validation.ts,client 也會載入)與 server 的 getSiteNotice(site-notice-server.ts)
// 共用同一份規則,所以這裡不能 import 任何 server 模組。

export const SITE_NOTICE_KEYS = {
  enabled: "core.notice.enabled",
  text: "core.notice.text",
  href: "core.notice.href",
  startsOn: "core.notice.startsOn",
  endsOn: "core.notice.endsOn",
} as const;

/** 公告最多幾個字(以 code point 算,中文一字算一個)。 */
export const SITE_NOTICE_MAX_LENGTH = 120;

export interface SiteNotice {
  text: string;
  /** 站內路徑(/products)或 https 網址;沒有就是純文字。 */
  href?: string;
}

/** 設定頁存下來的原始值(每一格都可能是 undefined 或壞值)。 */
export interface SiteNoticeValues {
  enabled?: unknown;
  text?: unknown;
  href?: unknown;
  startsOn?: unknown;
  endsOn?: unknown;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 看起來像 HTML 標籤的東西(<b>、</a>、<!--、<?php)。單獨的「<」「>」(買 >2 件)照收。
const TAG_RE = /<[a-zA-Z!/?]/;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;

export function textLength(value: string): number {
  return [...value].length;
}

/** 一行純文字:沒有換行、沒有 HTML 標籤。 */
export function isPlainLine(value: string): boolean {
  return !LINE_BREAK_RE.test(value) && !TAG_RE.test(value);
}

/**
 * 公告能連去的地方:站內路徑(/ 開頭,不是 // 開頭的協定相對網址)或 https 網址。
 * javascript:、http:、data: 一律不收;路徑裡不能有空白或反斜線(瀏覽器會把 /\ 當成 //)。
 */
export function isNoticeLink(value: string): boolean {
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` 而且是真的有的一天(擋掉 2026-02-31)。 */
export function isIsoDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 公告這個時間點要不要出現(出現的話長什麼樣)。日期以站台時區算:開始日當天 00:00
 * 起、結束日過完(隔天 00:00)為止。日期壞掉(只可能是繞過設定頁直接寫進資料庫)就不顯示 ——
 * 寧可少一則公告,也不要讓過期的活動一直掛著。
 */
export function resolveSiteNotice(
  values: SiteNoticeValues,
  now: number,
  timeZone: string,
): SiteNotice | null {
  if (values.enabled !== true) return null;
  const text = trimmed(values.text);
  if (!text || !isPlainLine(text) || textLength(text) > SITE_NOTICE_MAX_LENGTH) return null;

  const dates = createDateFormatter("en", timeZone);
  const startsOn = trimmed(values.startsOn);
  const endsOn = trimmed(values.endsOn);
  if (startsOn) {
    const start = dates.dayStart(startsOn);
    if (start === undefined || now < start) return null;
  }
  if (endsOn) {
    const end = dates.dayStart(endsOn, true);
    if (end === undefined || now >= end) return null;
  }

  const href = trimmed(values.href);
  return href && isNoticeLink(href) ? { text, href } : { text };
}
