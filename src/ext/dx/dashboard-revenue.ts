import type { DashboardRevenueContext, Extension } from "../types";
import { isDayKey } from "@/lib/report-period";
import { callDashboardHook, INVALID, isAdminHref, readText } from "./dashboard-hook";

// 1.61.0:插件交給儀表板「營業額」圖的每日金額(Extension.dashboardRevenue → RevenueSeries)。
// 儀表板每次畫營業額卡呼叫(這一段與前一段各一次),各插件的線疊在同一張長條圖上。
//
// 跟 dashboardStats 一樣,插件回來的東西一律當作不可信的輸入,儀表板絕不因為一個插件出錯:
//   - 每個插件的呼叫各自隔離(dashboard-hook.ts):丟例外、回傳不是陣列、超過 timeoutMs
//     → 這個插件的線都不畫,console.error 一行,別的插件照常。
//   - 每一條各自驗(normalizeRevenueSeries):id、label(最多 40 字,可在地化)、href(後台頁)、
//     days。不合規則的那一條丟掉並記一行,其餘照常。
//   - days 是物件:key 是 ctx.from..ctx.to 之間真的日期 YYYY-MM-DD,值是有限、≥ 0 的數字;
//     沒列的日子當 0。**有任何一天不合規則,整條丟掉** —— 只丟那一天會讓總額少算,而畫面上
//     看不出來;整條不見,圖例上就少了它,看得出來有問題。
//   - 同一個插件重複的 id 留第一條;一個插件最多 MAX_REVENUE_SERIES_PER_EXTENSION 條。
//   - 看的人打不開 href(ctx.canOpen)的那一條不畫、不記 log —— 那不是插件的錯。
//
// 每個插件拿到自己的一份 ctx(淺拷貝),改了也不影響別的插件。

/** 營業額要掃整段期間(最多 366 天),比 dashboardStats 的 2 秒寬一點。 */
export const DASHBOARD_REVENUE_TIMEOUT_MS = 3000;
export const MAX_REVENUE_SERIES_PER_EXTENSION = 4;

const SERIES_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LABEL_MAX = 40;
const TAG = "[dashboard-revenue]";

/** 驗過、解析成當前語言的一條每日金額。 */
export interface NormalizedRevenueSeries {
  id: string;
  label: string;
  href: string;
  /** 只有 from..to 之間的日子;沒列的是 0。 */
  days: Record<string, number>;
}

/** 儀表板用的一條:加上來自哪個插件,key = "<extId>/<id>"(跨插件唯一)。 */
export interface ResolvedRevenueSeries extends NormalizedRevenueSeries {
  extId: string;
  key: string;
}

type RevenueRules = Pick<DashboardRevenueContext, "locale" | "from" | "to">;

/** days 不合規則回原因;合規則回一份乾淨的拷貝。 */
function readDays(value: unknown, from: string, to: string): Record<string, number> | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "days must be an object";
  const days: Record<string, number> = {};
  for (const [day, amount] of Object.entries(value as Record<string, unknown>)) {
    if (!isDayKey(day) || day < from || day > to) return `day "${day.slice(0, 20)}" is not a date from ${from} to ${to}`;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return `day "${day}" must be a finite amount of at least 0`;
    }
    days[day] = amount;
  }
  return days;
}

/** 驗一條;不合規則回傳原因(記 log 用)。 */
export function normalizeRevenueSeries(entry: unknown, rules: RevenueRules): NormalizedRevenueSeries | string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "is not an object";
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !SERIES_ID_RE.test(e.id)) return "has an invalid id";
  const id = e.id;
  const label = readText(e.label, rules.locale, LABEL_MAX, true);
  if (label === undefined || label === INVALID) return `"${id}" needs a label of at most ${LABEL_MAX} characters`;
  if (!isAdminHref(e.href)) return `"${id}" href must be an admin path (/admin/...)`;
  const days = readDays(e.days, rules.from, rules.to);
  if (typeof days === "string") return `"${id}" ${days}`;
  return { id, label, href: e.href, days };
}

/** 驗一個插件回來的整份清單:丟掉壞的、重複的、超過上限的、看的人打不開的。 */
export function normalizeDashboardRevenue(
  extId: string,
  entries: readonly unknown[],
  ctx: RevenueRules & Pick<DashboardRevenueContext, "canOpen">,
): NormalizedRevenueSeries[] {
  const seen = new Set<string>();
  const valid: NormalizedRevenueSeries[] = [];
  entries.forEach((entry, index) => {
    const series = normalizeRevenueSeries(entry, ctx);
    if (typeof series === "string") {
      console.error(`${TAG} ext="${extId}" series[${index}] ${series}; dropped`);
      return;
    }
    if (seen.has(series.id)) {
      console.error(`${TAG} ext="${extId}" series[${index}] repeats id "${series.id}"; dropped`);
      return;
    }
    seen.add(series.id);
    valid.push(series);
  });
  if (valid.length > MAX_REVENUE_SERIES_PER_EXTENSION) {
    console.error(
      `${TAG} ext="${extId}" returned ${valid.length} series; only the first ${MAX_REVENUE_SERIES_PER_EXTENSION} are shown`,
    );
  }
  return valid.slice(0, MAX_REVENUE_SERIES_PER_EXTENSION).filter((series) => ctx.canOpen(series.href));
}

/** 呼叫一個插件的 dashboardRevenue,隔離它的失敗與逾時;沒宣告回 []。永遠不 throw。 */
export async function collectDashboardRevenue(
  ext: Extension,
  ctx: DashboardRevenueContext,
  timeoutMs: number = DASHBOARD_REVENUE_TIMEOUT_MS,
): Promise<NormalizedRevenueSeries[]> {
  const load = ext.dashboardRevenue;
  if (typeof load !== "function") return [];
  const raw = await callDashboardHook({
    tag: TAG,
    extId: ext.id,
    hook: "dashboardRevenue",
    timeoutMs,
    call: () => load({ ...ctx }),
  });
  return raw ? normalizeDashboardRevenue(ext.id, raw, ctx) : [];
}

/** 所有啟用插件的營業額線,照插件順序(同時呼叫)。 */
export async function resolveDashboardRevenue(
  exts: readonly Extension[],
  ctx: DashboardRevenueContext,
  timeoutMs?: number,
): Promise<ResolvedRevenueSeries[]> {
  const providers = exts.filter((ext) => typeof ext.dashboardRevenue === "function");
  const results = await Promise.all(providers.map((ext) => collectDashboardRevenue(ext, ctx, timeoutMs)));
  return providers.flatMap((ext, i) => results[i].map((series) => ({ ...series, extId: ext.id, key: `${ext.id}/${series.id}` })));
}

/** 一條線在這段期間的合計。 */
export function seriesTotal(series: Pick<NormalizedRevenueSeries, "days">): number {
  return Object.values(series.days).reduce((sum, amount) => sum + amount, 0);
}
