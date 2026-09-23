import type { DashboardStatsContext, Extension } from "../types";
import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";

// 1.52.0:code extension 自己的儀表板數字(Extension.dashboardStats)。dashboard-cards.ts 的
// resolveDashboardCards 呼叫這裡,結果跟 dashboardCards 的數字卡畫在一起。
//
// 插件回來的東西一律當作不可信的輸入 —— 儀表板絕不因為一個插件整頁出錯:
//   - 每個插件的呼叫各自隔離:丟例外(同步或非同步)、回傳不是陣列、超過 timeoutMs
//     → 這個插件的數字都不顯示,console.error 一行,別的插件照常。
//   - 每一筆各自驗(normalizeStat):不合規則的那一筆丟掉並記一行,其餘照常。只留已知
//     欄位,字串 trim,空的 display / hint 當作沒給。
//   - 同一個插件重複的 id 留第一筆;一個插件最多 MAX_STATS_PER_EXTENSION 筆。
//   - href 只能是後台頁(/admin 開頭、小寫路徑段、可帶 query),不能是外部網址或 //host。
//     看的人打不開(ctx.canOpen,1.52.0 dashboardViewer)的那一筆不顯示、不記 log ——
//     那不是插件的錯。插件自己拿得到 canOpen,可以先不查;core 這一關是保險。
//
// 每個插件拿到自己的一份 ctx(淺拷貝),改了也不影響別的插件。

export const DASHBOARD_STATS_TIMEOUT_MS = 2000;
export const MAX_STATS_PER_EXTENSION = 12;

const STAT_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ADMIN_HREF_RE = /^\/admin(?:\/[a-z0-9][a-z0-9._-]*)*(?:\?[^\s#]*)?$/;
const HREF_MAX = 512;
const TITLE_MAX = 60;
const DISPLAY_MAX = 24;
const HINT_MAX = 80;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 驗過、解析成當前語言的一個數字。 */
export interface NormalizedDashboardStat {
  id: string;
  title: string;
  href: string;
  value: number;
  display?: string;
  hint?: string;
}

const INVALID = Symbol("invalid");

/** 選填文字:沒給 / 空白 → undefined;型別錯、太長、有控制字元 → INVALID。 */
function readText(
  value: unknown,
  locale: Locale,
  max: number,
  localized: boolean,
): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  let text: unknown = value;
  if (localized && value !== null && typeof value === "object" && !Array.isArray(value)) {
    text = resolveLocalizedString(value as LocalizedString, locale);
  }
  if (typeof text !== "string") return INVALID;
  const trimmed = text.trim();
  if (trimmed.length > max || CONTROL_RE.test(trimmed)) return INVALID;
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 驗一筆;不合規則回傳原因(記 log 用)。 */
export function normalizeStat(entry: unknown, locale: Locale): NormalizedDashboardStat | string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "is not an object";
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !STAT_ID_RE.test(e.id)) return "has an invalid id";
  const id = e.id;
  const title = readText(e.title, locale, TITLE_MAX, true);
  if (title === undefined || title === INVALID) return `"${id}" needs a title of at most ${TITLE_MAX} characters`;
  if (typeof e.href !== "string" || e.href.length > HREF_MAX || !ADMIN_HREF_RE.test(e.href)) {
    return `"${id}" href must be an admin path (/admin/...)`;
  }
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

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * 呼叫一個插件的 dashboardStats,隔離它的失敗與逾時;沒宣告回 []。永遠不 throw。
 */
export async function collectDashboardStats(
  ext: Extension,
  ctx: DashboardStatsContext,
  timeoutMs: number = DASHBOARD_STATS_TIMEOUT_MS,
): Promise<NormalizedDashboardStat[]> {
  const load = ext.dashboardStats;
  if (typeof load !== "function") return [];
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  let raw: unknown;
  try {
    // Promise.resolve().then 讓同步 throw 也變成 rejection,一起在這裡接住。
    raw = await Promise.race([Promise.resolve().then(() => load({ ...ctx })), timeout]);
  } catch (error) {
    console.error(
      `[dashboard-stats] ext="${ext.id}" dashboardStats failed; skipped`,
      error instanceof Error ? error.message : error,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
  if (raw === timedOut) {
    console.error(`[dashboard-stats] ext="${ext.id}" dashboardStats took longer than ${timeoutMs}ms; skipped`);
    return [];
  }
  if (!Array.isArray(raw)) {
    console.error(`[dashboard-stats] ext="${ext.id}" dashboardStats returned ${describe(raw)}, not an array; skipped`);
    return [];
  }
  return normalizeDashboardStats(ext.id, raw, ctx);
}
