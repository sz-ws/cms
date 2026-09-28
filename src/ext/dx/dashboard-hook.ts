import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";

// 儀表板呼叫插件的共用部分(1.61.0 從 dashboard-stats.ts 抽出來;1.62.0 起 dashboardWidgets 與
// 舊的 dashboardStats、dashboardRevenue 共用):隔離一次呼叫、驗後台連結與文字。
//
// 插件回來的東西一律當作不可信的輸入:丟例外(同步或非同步)、回傳不是陣列、超過時限
// → 這個插件這次什麼都不顯示,console.error 一行,別的插件照常。永遠不 throw。

/** 後台頁:/admin 開頭、小寫路徑段、可帶 query;不能是外部網址、//host 或 ..。 */
const ADMIN_HREF_RE = /^\/admin(?:\/[a-z0-9][a-z0-9._-]*)*(?:\?[^\s#]*)?$/;
const HREF_MAX = 512;
/** 插件給的文字不能有控制字元(dashboardWidgets 的宣告與資料、舊的 dashboardStats 共用)。 */
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isAdminHref(value: unknown): value is string {
  return typeof value === "string" && value.length <= HREF_MAX && ADMIN_HREF_RE.test(value);
}

export const INVALID = Symbol("invalid");

/** 選填文字:沒給 / 空白 → undefined;型別錯、太長、有控制字元 → INVALID。 */
export function readText(
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

/** log 裡寫插件回了什麼型別:null、array 或 typeof。 */
export function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

export interface DashboardHookCall {
  /** log 的前綴,例:"[dashboard-stats]"。 */
  tag: string;
  extId: string;
  /** hook 的名字,例:"dashboardStats"。 */
  hook: string;
  timeoutMs: number;
  call: () => unknown;
}

/**
 * 1.62.0:呼叫一次插件的儀表板 hook,不管回什麼形狀;成功回 { value },丟例外或逾時回 null(記一行)。
 * dashboardWidgets 的 load() 用它(回的是物件或 null),形狀由呼叫端驗。
 */
export async function callDashboardLoad({ tag, extId, hook, timeoutMs, call }: DashboardHookCall): Promise<{ value: unknown } | null> {
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  let raw: unknown;
  try {
    // Promise.resolve().then 讓同步 throw 也變成 rejection,一起在這裡接住。
    raw = await Promise.race([Promise.resolve().then(call), timeout]);
  } catch (error) {
    console.error(`${tag} ext="${extId}" ${hook} failed; skipped`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (raw === timedOut) {
    console.error(`${tag} ext="${extId}" ${hook} took longer than ${timeoutMs}ms; skipped`);
    return null;
  }
  return { value: raw };
}

/** 呼叫一次插件的儀表板 hook;成功回陣列,失敗、逾時、不是陣列回 null(記一行)。 */
export async function callDashboardHook(request: DashboardHookCall): Promise<unknown[] | null> {
  const result = await callDashboardLoad(request);
  if (!result) return null;
  if (!Array.isArray(result.value)) {
    console.error(`${request.tag} ext="${request.extId}" ${request.hook} returned ${describe(result.value)}, not an array; skipped`);
    return null;
  }
  return result.value;
}
