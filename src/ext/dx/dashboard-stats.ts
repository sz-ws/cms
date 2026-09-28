import type { Extension } from "../types";
import type { LocalizedString } from "@/lib/i18n/localized";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";
import { callDashboardHook, INVALID, isAdminHref, readText } from "./dashboard-hook";
import type { WidgetEntry } from "./dashboard-widgets";

// @deprecated 1.62.0 —— 舊介面的轉接,2.0 整個檔案拿掉。
//
// 1.52.0 的 Extension.dashboardStats(插件自己的儀表板數字)。1.62.0 起插件改用 dashboardWidgets 的
// `kind: "number"`(單位由 unit 決定);這裡把舊的數字轉成同一條路上的 number 卡(dx/dashboard-widgets.ts),
// 畫出來跟以前一樣:件數照後台語言寫、插件自己寫好的 display 照原樣顯示(只有舊介面有 display)。
//
// 插件回來的東西一律當作不可信的輸入 —— 儀表板絕不因為一個插件整頁出錯:
//   - 每個插件的呼叫各自隔離:丟例外(同步或非同步)、回傳不是陣列、超過 timeoutMs
//     → 這個插件的數字都不顯示,console.error 一行,別的插件照常。
//   - 每一筆各自驗(normalizeStat):不合規則的那一筆丟掉並記一行,其餘照常。只留已知
//     欄位,字串 trim,空的 display / hint 當作沒給。
//   - 同一個插件重複的 id 留第一筆;一個插件最多 MAX_STATS_PER_EXTENSION 筆。
//   - href 只能是後台頁;看的人打不開(ctx.canOpen)的那一筆不顯示、不記 log。
//
// 每個插件拿到自己的一份 ctx(淺拷貝),改了也不影響別的插件。

/**
 * 1.52.0:插件放在儀表板上的一個數字(Extension.dashboardStats)。
 * @deprecated 1.62.0:改用 Extension.dashboardWidgets 的 `kind: "number"`。2.0 拿掉。
 */
export interface DashboardStat {
  /** 同一個插件內唯一:^[a-z0-9][a-z0-9-]{0,40}$。 */
  id: string;
  title: LocalizedString;
  /** 處理這件事的後台頁:`/admin` 開頭的站內路徑,可帶 query。看的人打不開就不顯示。 */
  href: string;
  /** 有限數字;沒給 display 時照後台語言格式化顯示。 */
  value: number;
  /** 插件自己格式化好的顯示字串,最多 24 字。 */
  display?: string;
  /** 標題下的一行小字(最多 80 字);沒給是插件名稱。 */
  hint?: LocalizedString;
}

/**
 * 1.52.0:dashboardStats 收到的內容。
 * @deprecated 1.62.0:dashboardWidgets 的 load() 收到 WidgetContext。2.0 拿掉。
 */
export interface DashboardStatsContext {
  /** 這次儀表板的時間(ms)。 */
  now: number;
  /** 站台時區(settings 的 core.timeZone,預設台北),「今天」照這個算。 */
  timeZone: string;
  /** 後台語言。 */
  locale: Locale;
  /** 看的人打不打得開這個後台連結;打不開的數字 core 會丟掉,插件可以先不查。 */
  canOpen: (href: string) => boolean;
}

export const DASHBOARD_STATS_TIMEOUT_MS = 2000;
export const MAX_STATS_PER_EXTENSION = 12;

const STAT_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TITLE_MAX = 60;
const DISPLAY_MAX = 24;
const HINT_MAX = 80;

/** 驗過、解析成當前語言的一個數字。 */
export interface NormalizedDashboardStat {
  id: string;
  title: string;
  href: string;
  value: number;
  display?: string;
  hint?: string;
}

/** 驗一筆;不合規則回傳原因(記 log 用)。 */
export function normalizeStat(entry: unknown, locale: Locale): NormalizedDashboardStat | string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "is not an object";
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !STAT_ID_RE.test(e.id)) return "has an invalid id";
  const id = e.id;
  const title = readText(e.title, locale, TITLE_MAX, true);
  if (title === undefined || title === INVALID) return `"${id}" needs a title of at most ${TITLE_MAX} characters`;
  if (!isAdminHref(e.href)) return `"${id}" href must be an admin path (/admin/...)`;
  if (typeof e.value !== "number" || !Number.isFinite(e.value)) return `"${id}" value must be a finite number`;
  const display = readText(e.display, locale, DISPLAY_MAX, false);
  if (display === INVALID) return `"${id}" display must be text of at most ${DISPLAY_MAX} characters`;
  const hint = readText(e.hint, locale, HINT_MAX, true);
  if (hint === INVALID) return `"${id}" hint must be text of at most ${HINT_MAX} characters`;
  return {
    id,
    title,
    href: e.href,
    value: e.value,
    ...(display !== undefined ? { display } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** 驗一個插件回來的整份清單:丟掉壞的、重複的、超過上限的、看的人打不開的。 */
export function normalizeDashboardStats(
  extId: string,
  entries: readonly unknown[],
  ctx: Pick<DashboardStatsContext, "locale" | "canOpen">,
): NormalizedDashboardStat[] {
  const seen = new Set<string>();
  const valid: NormalizedDashboardStat[] = [];
  entries.forEach((entry, index) => {
    const stat = normalizeStat(entry, ctx.locale);
    if (typeof stat === "string") {
      console.error(`[dashboard-stats] ext="${extId}" stats[${index}] ${stat}; dropped`);
      return;
    }
    if (seen.has(stat.id)) {
      console.error(`[dashboard-stats] ext="${extId}" stats[${index}] repeats id "${stat.id}"; dropped`);
      return;
    }
    seen.add(stat.id);
    valid.push(stat);
  });
  if (valid.length > MAX_STATS_PER_EXTENSION) {
    console.error(
      `[dashboard-stats] ext="${extId}" returned ${valid.length} stats; only the first ${MAX_STATS_PER_EXTENSION} are shown`,
    );
  }
  return valid.slice(0, MAX_STATS_PER_EXTENSION).filter((stat) => ctx.canOpen(stat.href));
}

/** 呼叫一個插件的 dashboardStats,隔離它的失敗與逾時;沒宣告回 []。永遠不 throw。 */
export async function collectDashboardStats(
  ext: Extension,
  ctx: DashboardStatsContext,
  timeoutMs: number = DASHBOARD_STATS_TIMEOUT_MS,
): Promise<NormalizedDashboardStat[]> {
  const load = ext.dashboardStats;
  if (typeof load !== "function") return [];
  const raw = await callDashboardHook({
    tag: "[dashboard-stats]",
    extId: ext.id,
    hook: "dashboardStats",
    timeoutMs,
    call: () => load({ ...ctx }),
  });
  return raw ? normalizeDashboardStats(ext.id, raw, ctx) : [];
}

/** 一個插件的 dashboardStats → number 卡(件數;display 照原樣)。 */
export async function legacyStatEntries(ext: Extension, ctx: DashboardStatsContext, timeoutMs?: number): Promise<WidgetEntry[]> {
  const stats = await collectDashboardStats(ext, ctx, timeoutMs);
  const extName = resolveLocalizedString(ext.name, ctx.locale) ?? ext.id;
  return stats.map((stat) => ({
    key: `${ext.id}:stat:${stat.id}`,
    extId: ext.id,
    extNames: [extName],
    kind: "number",
    title: stat.title,
    ...(stat.hint !== undefined ? { hint: stat.hint } : {}),
    href: stat.href,
    unit: { kind: "count" },
    combine: "sum",
    period: false,
    data: { kind: "number", value: stat.value },
    ...(stat.display !== undefined ? { display: stat.display } : {}),
  }));
}
