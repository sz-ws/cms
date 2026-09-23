import type { Locale } from "@/lib/i18n";

// 1.41.0:日期與時間一律經過這一層,用站台時區(settings 的 core.timeZone)。
//
// 為什麼需要:Workers 的執行環境是 UTC。server component 或 route handler 裡寫
// `new Date(ms).toLocaleString("zh-TW")`,畫出來的是 UTC —— 在台灣差 8 小時,半夜
// 下的單日期還會差一天;client component 第一次也是在 server 上 render,之後瀏覽器
// 用自己的時區再算一次,兩邊對不上。這裡把「哪個時區」固定成站台設定,server 與
// 瀏覽器算出同一個字串。
//
//   - server:`getDateFormatter()`(lib/datetime-server.ts)
//   - client:`useDateFormatter()`(components/DateTimeProvider.tsx;root layout 已包好)
//   - 兩者都回同一個 DateFormatter,本檔的純函式可在任何地方用。
//
// 只負責「epoch ms ↔ 站台時區的牆上時間」。儲存一律是 epoch ms(UTC),不變。

export const DEFAULT_TIME_ZONE = "Asia/Taipei";

/** 設定頁的選項(core.timeZone)。 */
export const TIME_ZONE_OPTIONS: { value: string; label: { en: string; "zh-Hant": string } }[] = [
  { value: "Asia/Taipei", label: { en: "Taipei (UTC+8)", "zh-Hant": "台北（UTC+8）" } },
  { value: "Asia/Hong_Kong", label: { en: "Hong Kong (UTC+8)", "zh-Hant": "香港（UTC+8）" } },
  { value: "Asia/Shanghai", label: { en: "Shanghai (UTC+8)", "zh-Hant": "上海（UTC+8）" } },
  { value: "Asia/Singapore", label: { en: "Singapore (UTC+8)", "zh-Hant": "新加坡（UTC+8）" } },
  { value: "Asia/Tokyo", label: { en: "Tokyo (UTC+9)", "zh-Hant": "東京（UTC+9）" } },
  { value: "Asia/Seoul", label: { en: "Seoul (UTC+9)", "zh-Hant": "首爾（UTC+9）" } },
  { value: "Asia/Bangkok", label: { en: "Bangkok (UTC+7)", "zh-Hant": "曼谷（UTC+7）" } },
  { value: "Australia/Sydney", label: { en: "Sydney", "zh-Hant": "雪梨" } },
  { value: "Europe/London", label: { en: "London", "zh-Hant": "倫敦" } },
  { value: "Europe/Paris", label: { en: "Paris", "zh-Hant": "巴黎" } },
  { value: "America/New_York", label: { en: "New York", "zh-Hant": "紐約" } },
  { value: "America/Los_Angeles", label: { en: "Los Angeles", "zh-Hant": "洛杉磯" } },
  { value: "UTC", label: { en: "UTC", "zh-Hant": "UTC（世界協調時間）" } },
];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tag: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tag}|${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(tag, { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

/** 認得的 IANA 時區(執行環境的 Intl 說了算)。 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: unknown, fallback = DEFAULT_TIME_ZONE): string {
  return isTimeZone(value) ? value : fallback;
}

function localeTag(locale: Locale | string): string {
  return locale === "zh-Hant" ? "zh-TW" : locale === "en" ? "en-US" : locale;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const WALL: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** epoch ms 在該時區的牆上時間。 */
export function wallClock(ms: number, timeZone: string): WallClock {
  const parts = formatter("en-US", timeZone, WALL).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** 該時區在這個瞬間比 UTC 快多少 ms(台北 = +8h;有夏令時間的地方依日期而變)。 */
export function timeZoneOffsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** 該時區的牆上時間 → epoch ms。夏令時間切換時不存在的時刻往後推、重複的時刻取第一個。 */
export function zonedTimeToMs(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): number {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0);
  const first = utc - timeZoneOffsetMs(utc, timeZone);
  const second = utc - timeZoneOffsetMs(first, timeZone);
  return Math.min(first, second);
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateFormatter {
  readonly timeZone: string;
  readonly locale: Locale;
  /** 2026/9/18(en:9/18/2026) */
  date(ms: number): string;
  /** 2026/9/18 14:05 */
  dateTime(ms: number): string;
  /** 14:05 */
  time(ms: number): string;
  /** 9/18 */
  monthDay(ms: number): string;
  /** 自訂 Intl 選項;時區固定是站台的。 */
  format(ms: number, options: Intl.DateTimeFormatOptions): string;
  /** 2026-09-18 14:05:00 —— 給 CSV 之類要排序、不分語系的地方。 */
  stamp(ms: number): string;
  /** 站台時區的日期鍵 `YYYY-MM-DD`(日期欄位、依日分組)。 */
  dayKey(ms: number): string;
  /** `YYYY-MM-DD` → 站台時區當天 00:00 的 epoch ms;end 時回隔天 00:00(不含上限)。 */
  dayStart(day: string, end?: boolean): number | undefined;
}

const ODD_SPACES = /[\u00a0\u2009\u202f]/g;
const DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };

export function createDateFormatter(locale: Locale, timeZone: string): DateFormatter {
  const tz = normalizeTimeZone(timeZone);
  const tag = localeTag(locale);
  // 新版 ICU(Node 26 / CLDR 48)在日期與時間之間放細空白 U+2009,Chrome 放一般空白:
  // server render 與 hydration 的字串就對不上,React 會整棵重畫。一律換成一般空白。
  const format = (ms: number, options: Intl.DateTimeFormatOptions) =>
    Number.isFinite(ms) ? formatter(tag, tz, options).format(new Date(ms)).replace(ODD_SPACES, " ") : "";
  const dayKey = (ms: number) => {
    const w = wallClock(ms, tz);
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  };
  return {
    timeZone: tz,
    locale,
    date: (ms) => format(ms, DATE),
    dateTime: (ms) => format(ms, DATE_TIME),
    time: (ms) => format(ms, TIME),
    monthDay: (ms) => format(ms, MONTH_DAY),
    format,
    stamp: (ms) => {
      if (!Number.isFinite(ms)) return "";
      const w = wallClock(ms, tz);
      return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
    },
    dayKey,
    dayStart: (day, end = false) => {
      const m = DAY_RE.exec(day);
      if (!m) return undefined;
      const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const start = zonedTimeToMs({ year, month, day: date }, tz);
      // 2026-02-31 這種不存在的日期:Date.UTC 會滾到下個月,這裡擋掉。
      if (dayKey(start) !== day) return undefined;
      return end ? zonedTimeToMs({ year, month, day: date + 1 }, tz) : start;
    },
  };
}
