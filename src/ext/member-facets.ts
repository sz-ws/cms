import type { CoreServices } from "./services";
import type {
  Extension,
  MemberFacet,
  MemberFacetAction,
  MemberFacetContext,
  MemberFacetValue,
} from "./types";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { Locale } from "@/lib/i18n/index";

// 1.60.0:成員頁上,插件說明「這個人對我是什麼」(Extension.memberFacets)。
//
// 每個 facet 在成員表多一欄(badge)、篩選列多一組「有／沒有」、匯出 CSV 多一欄、成員側欄
// 多一段(lines 與 actions)。成員頁(users-data.ts)一次讀所有人,所有插件的 facet 同時讀。
//
// 插件回來的東西一律當作不可信的輸入 —— 成員頁絕不因為一個插件整頁出錯:
//   - 每個 facet 各自隔離:read 丟例外(同步或非同步)、回傳不是物件、超過 timeoutMs、
//     拿不到 services → 這個 facet 整個不出現(沒有欄位、篩選、匯出欄、側欄段落),
//     console.error 一行,別的 facet 照常。
//   - 每個人的值各自驗(normalizeFacetValue):不合規則的那一筆丟掉,一個 facet 只記一行。
//     沒有要讀的人(不在 userIds 裡的 key)直接略過。
//   - actions 的 href 丟例外或不是後台頁 → 那個連結不出現,一個 facet 只記一行。
//
// 這個檔案也給瀏覽器用(key 的規則、交給畫面的形狀):只 import type 與純函式。

/** 同一個插件內的 facet id。 */
export const MEMBER_FACET_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
/** 全站唯一的 key:`<extId>.<facetId>`。成員表的欄位、篩選的網址參數名都用它。 */
export const MEMBER_FACET_KEY_RE = /^[a-z][a-z0-9-]{1,30}\.[a-z][a-z0-9-]{0,30}$/;

export const MEMBER_FACETS_TIMEOUT_MS = 3000;
export const MAX_MEMBER_FACETS = 4;
export const MAX_MEMBER_FACET_ACTIONS = 4;

const BADGE_MAX = 32;
const LINES_MAX = 8;
const LINE_LABEL_MAX = 40;
const LINE_VALUE_MAX = 200;
const HREF_MAX = 512;
// 同儀表板數字(dx/dashboard-stats.ts):站內後台頁,小寫路徑段,可帶 query。
const ADMIN_HREF_RE = /^\/admin(?:\/[a-z0-9][a-z0-9._-]*)*(?:\?[^\s#]*)?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function memberFacetKey(extId: string, facetId: string): string {
  return `${extId}.${facetId}`;
}

// ---- 交給畫面的形狀(可序列化) ----

/** 成員頁上的一個 facet:表格的欄、篩選、匯出的欄、側欄的段落共用。 */
export interface MemberFacetColumn {
  /** `<extId>.<facetId>`。 */
  key: string;
  /** 照後台語言解析好的名稱。 */
  label: string;
}

export interface UserFacetLine {
  label: string;
  value: string;
}

/** 驗過的值:表格與匯出用 badge,側欄用 lines。 */
export interface UserFacetValue {
  badge: string;
  lines: UserFacetLine[];
}

/** 一個人在一個 facet 上的樣子(驗過)。 */
export interface UserFacet {
  /** 這個 facet 適用這個人時才有。 */
  value?: UserFacetValue;
  /** 側欄的連結:照 when 挑過,href 驗過。 */
  actions: { label: string; href: string }[];
}

/** facet key → 這個人在那個 facet 上的樣子;沒有值也沒有連結的 facet 不放。 */
export type UserFacets = Readonly<Record<string, UserFacet>>;

export function hasFacetValue(facets: UserFacets | undefined, key: string): boolean {
  return facets?.[key]?.value !== undefined;
}

// ---- 驗證 ----

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL_RE.test(trimmed)) return null;
  return trimmed;
}

/** 驗一個人的值;不合規則回傳原因(記 log 用)。 */
export function normalizeFacetValue(raw: unknown): UserFacetValue | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "is not an object";
  const entry = raw as Record<string, unknown>;
  const badge = text(entry.badge, BADGE_MAX);
  if (badge === null) return `badge must be text of 1–${BADGE_MAX} characters`;
  if (entry.lines === undefined) return { badge, lines: [] };
  if (!Array.isArray(entry.lines) || entry.lines.length > LINES_MAX) {
    return `lines must be a list of at most ${LINES_MAX}`;
  }
  const lines: UserFacetLine[] = [];
  for (const line of entry.lines as unknown[]) {
    const row = line !== null && typeof line === "object" ? (line as Record<string, unknown>) : {};
    const label = text(row.label, LINE_LABEL_MAX);
    const value = text(row.value, LINE_VALUE_MAX);
    if (label === null || value === null) {
      return `each line needs a label (≤ ${LINE_LABEL_MAX}) and a value (≤ ${LINE_VALUE_MAX})`;
    }
    lines.push({ label, value });
  }
  return { badge, lines };
}

function isAdminHref(href: unknown): href is string {
  return typeof href === "string" && href.length <= HREF_MAX && ADMIN_HREF_RE.test(href);
}

function actionApplies(action: MemberFacetAction, has: boolean): boolean {
  return action.when === "always" || (action.when === "has") === has;
}

// ---- 讀 ----

export interface ReadMemberFacetsOptions {
  locale: Locale;
  timeZone: string;
  /** 這個插件的 services(scope 綁在它的 extId)。每個有 facet 的插件叫一次。 */
  services: (extId: string) => CoreServices | Promise<CoreServices>;
  timeoutMs?: number;
}

export interface MemberFacetsResult {
  /** 讀成功的 facet,照插件順序、再照宣告順序。 */
  facets: MemberFacetColumn[];
  /** userId → 那個人的 facets;沒有任何 facet 的人不在裡面。 */
  byUser: Map<string, Record<string, UserFacet>>;
}

interface Declared {
  ext: Extension;
  facet: MemberFacet;
  key: string;
}

const TIMED_OUT = Symbol("timeout");

async function withTimeout<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    // Promise.resolve().then 讓同步 throw 也變成 rejection,由呼叫端一起接住。
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** 一個人的值:插件回來的原樣(給 action 的 href)與驗過的樣子(給畫面)。 */
interface ReadValue {
  raw: MemberFacetValue;
  value: UserFacetValue;
}

/** 讀一個 facet;失敗回 null(已記 log)。 */
async function readOne(
  { ext, facet }: Declared,
  userIds: readonly string[],
  ctx: MemberFacetContext,
  timeoutMs: number,
): Promise<Map<string, ReadValue> | null> {
  const where = `[member-facets] ext="${ext.id}" facet="${facet.id}"`;
  let raw: unknown;
  try {
    raw = await withTimeout(() => facet.read([...userIds], { ...ctx }), timeoutMs);
  } catch (error) {
    console.error(`${where} read failed; skipped`, error instanceof Error ? error.message : error);
    return null;
  }
  if (raw === TIMED_OUT) {
    console.error(`${where} read took longer than ${timeoutMs}ms; skipped`);
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`${where} read returned ${describe(raw)}, not an object; skipped`);
    return null;
  }
  const wanted = new Set(userIds);
  const values = new Map<string, ReadValue>();
  let dropped = 0;
  let firstReason = "";
  for (const [userId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!wanted.has(userId)) continue;
    const value = normalizeFacetValue(entry);
    if (typeof value === "string") {
      dropped++;
      firstReason ||= value;
      continue;
    }
    values.set(userId, { raw: entry as MemberFacetValue, value });
  }
  if (dropped > 0) {
    console.error(`${where} dropped ${dropped} value(s): ${firstReason}`);
  }
  return values;
}

/** 這個 facet 在每個人身上的樣子;沒有值、也沒有連結的人不放。 */
function facetsPerUser(
  { ext, facet }: Declared,
  userIds: readonly string[],
  values: ReadonlyMap<string, ReadValue>,
  locale: Locale,
): Map<string, UserFacet> {
  const actions = (facet.actions ?? []).map((action) => ({
    action,
    label: resolveLocalizedString(action.label, locale) || facet.id,
  }));
  const out = new Map<string, UserFacet>();
  let badHrefs = 0;
  for (const userId of userIds) {
    const found = values.get(userId);
    const links: UserFacet["actions"] = [];
    for (const { action, label } of actions) {
      if (!actionApplies(action, found !== undefined)) continue;
      let href: unknown;
      try {
        href = action.href(userId, found?.raw);
      } catch {
        href = undefined;
      }
      if (isAdminHref(href)) links.push({ label, href });
      else badHrefs++;
    }
    if (found || links.length > 0) {
      out.set(userId, { ...(found ? { value: found.value } : {}), actions: links });
    }
  }
  if (badHrefs > 0) {
    console.error(
      `[member-facets] ext="${ext.id}" facet="${facet.id}" dropped ${badHrefs} action link(s): href must be an admin path (/admin/...)`,
    );
  }
  return out;
}

/**
 * 讀所有啟用中插件的 facet(同時讀),驗過之後交給成員頁。永遠不 throw。
 * 沒有插件宣告 memberFacets 時不叫 services、不讀任何東西。
 */
export async function readMemberFacets(
  exts: readonly Extension[],
  userIds: readonly string[],
  options: ReadMemberFacetsOptions,
): Promise<MemberFacetsResult> {
  const declared: Declared[] = exts.flatMap((ext) =>
    (ext.memberFacets ?? []).map((facet) => ({ ext, facet, key: memberFacetKey(ext.id, facet.id) })),
  );
  if (declared.length === 0) return { facets: [], byUser: new Map() };

  const timeoutMs = options.timeoutMs ?? MEMBER_FACETS_TIMEOUT_MS;
  // 一個插件只建一次 services(同一個插件的幾個 facet 共用)。
  const servicesByExt = new Map<string, Promise<CoreServices>>();
  const servicesFor = (extId: string) => {
    let services = servicesByExt.get(extId);
    if (!services) {
      services = Promise.resolve().then(() => options.services(extId));
      servicesByExt.set(extId, services);
    }
    return services;
  };

  const results = await Promise.all(
    declared.map(async (entry) => {
      let services: CoreServices;
      try {
        services = await servicesFor(entry.ext.id);
      } catch (error) {
        console.error(
          `[member-facets] ext="${entry.ext.id}" services unavailable; facet "${entry.facet.id}" skipped`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }
      const values = await readOne(entry, userIds, { services, locale: options.locale, timeZone: options.timeZone }, timeoutMs);
      return values ? { entry, values } : null;
    }),
  );

  const facets: MemberFacetColumn[] = [];
  const byUser = new Map<string, Record<string, UserFacet>>();
  for (const result of results) {
    if (!result) continue;
    const { entry, values } = result;
    facets.push({ key: entry.key, label: resolveLocalizedString(entry.facet.label, options.locale) || entry.facet.id });
    for (const [userId, facet] of facetsPerUser(entry, userIds, values, options.locale)) {
      byUser.set(userId, { ...byUser.get(userId), [entry.key]: facet });
    }
  }
  return { facets, byUser };
}
