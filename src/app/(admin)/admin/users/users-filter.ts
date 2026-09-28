import type { MessageKey } from "@/lib/i18n";
import { normalizeTimeZone, zonedTimeToMs } from "@/lib/datetime";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { formatStatusList, parseStatusList } from "@/lib/status-filter";
import { MEMBER_FACET_KEY_RE, hasFacetValue } from "@/ext/member-facets";
import type { RoleOption, UserRecord } from "./UsersTable";
import { USERS_VIEW_PARAM, parseUsersView, usersInView, type UsersView } from "./users-view";

// 1.59.0:成員頁的搜尋與篩選(純函式)。畫面(UsersTable,資料已在手上,即時篩)與
// 匯出 CSV 的路由(GET /api/users/export,在伺服器上再篩一次)共用這一份,兩邊不會各算各的。
//
// 網址(跟 ?view= 放在一起,重新整理、分享連結都保留):
//
//   ?q=王                          姓名或 Email,不分大小寫、部分符合
//   ?role=admin,role:<id>          角色(只有後台人員這組);寫法同 lib/status-filter.ts
//   ?joinedFrom=2026-09-01&joinedTo=2026-09-28     加入日期(含頭含尾)
//   ?activeFrom=…&activeTo=…                        最近上線(從未登入的人不會符合)
//   ?<extId>.<facetId>=has|missing                  1.60.0:插件的 facet(ext/member-facets.ts)
//                                                   有值 / 沒有值;其他值 = 不限
//
// 日期是站台時區(core.timeZone)的一整天:伺服器與瀏覽器用同一個時區換算,網址上是
// 人看得懂的 YYYY-MM-DD,不是 epoch。認不得的值直接略過,不報錯(篩選不該讓整頁失敗)。

const USERS_QUERY_PARAM = "q";
const USERS_ROLE_PARAM = "role";
const JOINED_FROM_PARAM = "joinedFrom";
const JOINED_TO_PARAM = "joinedTo";
const ACTIVE_FROM_PARAM = "activeFrom";
const ACTIVE_TO_PARAM = "activeTo";

/** 這一頁自己管的參數;換網址時先拿掉再寫回,其他參數原樣保留。 */
const OWN_PARAMS = [
  USERS_VIEW_PARAM,
  USERS_QUERY_PARAM,
  USERS_ROLE_PARAM,
  JOINED_FROM_PARAM,
  JOINED_TO_PARAM,
  ACTIVE_FROM_PARAM,
  ACTIVE_TO_PARAM,
];

const MAX_QUERY = 100;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---- 角色 ----

/** 角色選單與篩選的值:預設角色,或 `role:<自訂角色 id>`。 */
export type RoleChoice = "admin" | "editor" | "guest" | `role:${string}`;

export function choiceOf(user: Pick<UserRecord, "role" | "staffRoleId">): RoleChoice {
  return user.staffRoleId ? `role:${user.staffRoleId}` : user.role;
}

/** 後台人員這組可以篩的角色,照選單的順序:管理員、工作人員、各自訂角色。 */
export function staffRoleChoices(roleIds: readonly string[]): RoleChoice[] {
  return ["admin", "editor", ...roleIds.map((id): RoleChoice => `role:${id}`)];
}

/** 角色的顯示名稱(表格的角色標籤與 CSV 同一套字)。 */
export function roleLabel(
  user: Pick<UserRecord, "role" | "staffRoleId">,
  t: (key: MessageKey) => string,
  roles: readonly Pick<RoleOption, "id" | "name">[],
): string {
  if (user.staffRoleId) {
    return roles.find((r) => r.id === user.staffRoleId)?.name ?? t("usersTable.roleGuest");
  }
  if (user.role === "admin") return t("usersTable.roleAdmin");
  if (user.role === "guest") return t("usersTable.roleGuest");
  return t("usersTable.roleEditor");
}

// ---- 條件 ----

/** 一段日期(站台時區的 YYYY-MM-DD,頭尾都含);null = 不限。 */
export interface DayRange {
  from: string | null;
  to: string | null;
}

/** 1.60.0:插件 facet 的篩選 —— 有值的人 / 沒有值的人。 */
export type FacetChoice = "has" | "missing";

export interface UsersFilter {
  view: UsersView;
  /** 搜尋框的字(可能帶前後空白,比對與寫網址前才 normalizeUsersQuery);空 = 不搜尋。 */
  q: string;
  /** 只在後台人員這組有意義;空陣列 = 全部角色。 */
  roles: RoleChoice[];
  joined: DayRange;
  active: DayRange;
  /** 1.60.0:facet key(`<extId>.<facetId>`)→ 有 / 沒有;沒列的 facet 不限。 */
  facets: Readonly<Record<string, FacetChoice>>;
}

const ANY_DAY: DayRange = { from: null, to: null };

export function emptyUsersFilter(view: UsersView = "staff"): UsersFilter {
  return { view, q: "", roles: [], joined: ANY_DAY, active: ANY_DAY, facets: {} };
}

export function hasDayRange(range: DayRange): boolean {
  return range.from !== null || range.to !== null;
}

/** 除了分組以外,有沒有任何條件(搜尋或篩選)。 */
export function isUsersFiltered(filter: UsersFilter): boolean {
  return normalizeUsersQuery(filter.q) !== "" || hasUsersNarrowing(filter);
}

/** 搜尋以外的篩選(角色、日期、facet)。 */
export function hasUsersNarrowing(filter: UsersFilter): boolean {
  return (
    filter.roles.length > 0 ||
    hasDayRange(filter.joined) ||
    hasDayRange(filter.active) ||
    Object.keys(filter.facets).length > 0
  );
}

/** 設定(或清掉:null)一個 facet 的篩選,回傳新的條件。 */
export function withFacetChoice(filter: UsersFilter, key: string, choice: FacetChoice | null): UsersFilter {
  const facets = Object.fromEntries(Object.entries(filter.facets).filter(([k]) => k !== key));
  return { ...filter, facets: choice ? { ...facets, [key]: choice } : facets };
}

/** 清掉搜尋與篩選,留在同一組。 */
export function clearUsersFilter(filter: UsersFilter): UsersFilter {
  return emptyUsersFilter(filter.view);
}

/** 換組:搜尋與日期跟著走;角色只屬於後台人員,到會員就拿掉。 */
export function switchUsersView(filter: UsersFilter, view: UsersView): UsersFilter {
  return { ...filter, view, roles: view === "staff" ? filter.roles : [] };
}

// ---- 網址 ↔ 條件 ----

type ParamValue = string | readonly string[] | null | undefined;
/** server component 的 searchParams(物件)或 route handler 的 URLSearchParams。 */
type UsersParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: UsersParamSource, name: string): ParamValue {
  if (source instanceof URLSearchParams) {
    const all = source.getAll(name);
    return all.length > 1 ? all : (all[0] ?? null);
  }
  return source[name];
}

function first(value: ParamValue): string {
  return (typeof value === "string" ? value : value?.[0]) ?? "";
}

/** 合法的日子才收(2026-02-31 這種會滾到下個月的擋掉;年份 2000–2199)。 */
function parseDay(value: ParamValue): string | null {
  const raw = first(value).trim();
  const m = DAY_RE.exec(raw);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2199) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? raw : null;
}

/** 頭尾填反了就對調(YYYY-MM-DD 可以直接比字串)。 */
function dayRange(from: string | null, to: string | null): DayRange {
  return from !== null && to !== null && from > to ? { from: to, to: from } : { from, to };
}

/** 搜尋字串的正規化:去頭尾空白、限長。 */
export function normalizeUsersQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY);
}

/** facet 的網址參數:has / missing 才收,其他(含兩者都有)= 不限。 */
function parseFacetChoice(value: ParamValue): FacetChoice | null {
  const raw = first(value).trim();
  return raw === "has" || raw === "missing" ? raw : null;
}

/**
 * 網址參數 → 條件。roleIds 是現有的自訂角色(認不得的角色值略過);facetKeys 是這次讀到的
 * 插件 facet(沒讀到的 facet 參數略過 —— 插件停用或讀壞時,篩選變成不限,不會整頁空掉)。
 */
export function parseUsersFilter(
  source: UsersParamSource,
  roleIds: readonly string[],
  facetKeys: readonly string[] = [],
): UsersFilter {
  const view = parseUsersView(first(read(source, USERS_VIEW_PARAM)));
  const facets: Record<string, FacetChoice> = {};
  for (const key of facetKeys) {
    const choice = parseFacetChoice(read(source, key));
    if (choice) facets[key] = choice;
  }
  return {
    view,
    q: normalizeUsersQuery(first(read(source, USERS_QUERY_PARAM))),
    roles: view === "staff" ? parseStatusList(read(source, USERS_ROLE_PARAM), staffRoleChoices(roleIds)) : [],
    joined: dayRange(parseDay(read(source, JOINED_FROM_PARAM)), parseDay(read(source, JOINED_TO_PARAM))),
    active: dayRange(parseDay(read(source, ACTIVE_FROM_PARAM)), parseDay(read(source, ACTIVE_TO_PARAM))),
    facets,
  };
}

/** 條件 → 網址參數(與 parseUsersFilter 對稱;後台人員是預設,不帶 view)。匯出連結也用它。 */
export function usersFilterParams(filter: UsersFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.view === "members") params.set(USERS_VIEW_PARAM, "members");
  const q = normalizeUsersQuery(filter.q);
  if (q) params.set(USERS_QUERY_PARAM, q);
  const roles = filter.view === "staff" ? formatStatusList(filter.roles) : null;
  if (roles) params.set(USERS_ROLE_PARAM, roles);
  const days: [string, string | null][] = [
    [JOINED_FROM_PARAM, filter.joined.from],
    [JOINED_TO_PARAM, filter.joined.to],
    [ACTIVE_FROM_PARAM, filter.active.from],
    [ACTIVE_TO_PARAM, filter.active.to],
  ];
  for (const [name, day] of days) if (day) params.set(name, day);
  // facet 照 key 排,同一組條件永遠只有一種網址。
  for (const key of Object.keys(filter.facets).sort()) {
    if (MEMBER_FACET_KEY_RE.test(key)) params.set(key, filter.facets[key]);
  }
  return params;
}

/** 目前網址換成這組條件:其他參數與 hash 保留(facet 形狀的參數算這一頁的)。 */
export function hrefForUsersFilter(current: string, filter: UsersFilter): string {
  const url = new URL(current);
  const facetParams = [...url.searchParams.keys()].filter((name) => MEMBER_FACET_KEY_RE.test(name));
  for (const name of [...OWN_PARAMS, ...facetParams]) url.searchParams.delete(name);
  for (const [name, value] of usersFilterParams(filter)) url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

// ---- 篩選 ----

/** 比對用的字:全形轉半形(輸入法打出的 ｇｍａｉｌ)、不分大小寫。 */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function matchesQuery(user: UserRecord, needle: string): boolean {
  if (fold(user.name).includes(needle)) return true;
  // 合成的 placeholder email(第三方登入拿不到 email)畫面上是遮起來的,搜尋也不比對它。
  return !isPlaceholderEmail(user.email) && fold(user.email).includes(needle);
}

interface MsRange {
  from?: number;
  /** 不含。 */
  to?: number;
}

function dayStartMs(day: string, timeZone: string, next: boolean): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  // 隔天 00:00(to 不含):Date.UTC 會把 9/31 滾成 10/1,月底也對。
  return zonedTimeToMs({ year, month, day: date + (next ? 1 : 0) }, timeZone);
}

function msRange(range: DayRange, timeZone: string): MsRange | null {
  if (!hasDayRange(range)) return null;
  return {
    ...(range.from ? { from: dayStartMs(range.from, timeZone, false) } : {}),
    ...(range.to ? { to: dayStartMs(range.to, timeZone, true) } : {}),
  };
}

function inRange(ms: number | null, range: MsRange | null): boolean {
  if (!range) return true;
  if (ms === null) return false;
  return (range.from === undefined || ms >= range.from) && (range.to === undefined || ms < range.to);
}

/**
 * 這組條件下顯示的人,順序不變。timeZone 是站台時區(client:useDateFormatter().timeZone;
 * server:getSiteTimeZone()),決定「一天」從哪一刻算起。
 */
export function filterUsers(
  users: readonly UserRecord[],
  filter: UsersFilter,
  timeZone: string,
): UserRecord[] {
  const tz = normalizeTimeZone(timeZone);
  const needle = fold(normalizeUsersQuery(filter.q));
  const roles = filter.view === "staff" && filter.roles.length > 0 ? new Set<string>(filter.roles) : null;
  const joined = msRange(filter.joined, tz);
  const active = msRange(filter.active, tz);
  const facets = Object.entries(filter.facets);
  return usersInView(users, filter.view).filter(
    (user) =>
      (needle === "" || matchesQuery(user, needle)) &&
      (roles === null || roles.has(choiceOf(user))) &&
      inRange(user.createdAt, joined) &&
      inRange(user.lastActiveAt, active) &&
      facets.every(([key, choice]) => hasFacetValue(user.facets, key) === (choice === "has")),
  );
}
