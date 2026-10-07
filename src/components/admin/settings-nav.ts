import type { Locale } from "@/lib/i18n";
import { resolveLocalizedString } from "@/lib/i18n/localized";
import type { SettingField } from "@/lib/settings";
import { settingControlId } from "@/lib/settings-ui";

// 設定頁左邊那一欄:有哪些地方可以去、網址怎麼對到其中一區、哪幾區要加標記。
// 純資料與純函式,跟畫面(SettingsNav.tsx)分開是為了可以單獨測。
//
// 四個分類就是原本的四個分頁(核心 / 風格 / 宣告式 / 擴充功能)。網址沿用 ?tab=,
// 再加一個 ?section=;每個分類的第一區不帶 section,所以舊的 ?tab= 連結照舊,
// 選到第一區時網址也跟以前一樣。舊的 #section-<id> 錨點由 resolveSettingsHash 接住。

export type SettingsArea = "core" | "style" | "declarative" | "extensions";

export const SETTINGS_AREAS: readonly SettingsArea[] = ["core", "style", "declarative", "extensions"];

/** AI 設定那一區的 id(AI 連線排在它後面)。 */
export const AI_SECTION_ID = "core-ai";
export const AI_CONNECT_ID = "ai-connect";
export const EXTRA_FIELDS_ID = "extra-fields";
export const CORE_ADDON_ID = "core-addon";
export const STYLE_ID = "style";
export const DECLARATIVE_ID = "declarative";

/** 帳戶頁「已連結帳號」那一塊(admin/account/page.tsx 上的 id)。 */
export const ACCOUNT_LINK_HREF = "/admin/account#connected-accounts";

const SETTINGS_PATH = "/admin/settings";

export interface SettingsNavSection {
  id: string;
  title: string;
  description?: string;
  keyPrefix: string;
  fields: readonly SettingField[];
}

export interface SettingsNavField {
  /** 完整的設定 key(keyPrefix + field.key)。 */
  fullKey: string;
  /** 輸入框的 DOM id(settingControlId)。 */
  controlId: string;
  label: string;
  description: string;
}

/** fields:進整頁表單的一組設定;panel:自己管儲存的區塊(風格、AI 連線、額外欄位…)。 */
export type SettingsNavKind = "fields" | "panel";

export interface SettingsNavItem {
  /** 分類 + id,整份清單裡不重複(擴充功能的代號可能跟內建區塊同名)。 */
  key: string;
  /** 網址 ?section= 與錨點 #section-<id> 用的 id。 */
  id: string;
  area: SettingsArea;
  kind: SettingsNavKind;
  title: string;
  description: string;
  /** 搜尋時額外比對的字(畫面上不顯示)。 */
  keywords: string;
  fields: SettingsNavField[];
}

export interface SettingsNavGroup {
  area: SettingsArea;
  label: string;
  items: SettingsNavItem[];
}

/** 清單最後那種「去別頁」的連結(不是設定的其中一區)。 */
export interface SettingsNavLink {
  id: string;
  title: string;
  description: string;
  keywords: string;
  href: string;
}

export interface SettingsNavText {
  title: string;
  description?: string;
  keywords?: string;
}

export interface SettingsNavInput {
  sections: readonly SettingsNavSection[];
  locale: Locale;
  areaLabels: Readonly<Record<SettingsArea, string>>;
  /** 有給才會出現在清單上。 */
  panels: {
    aiConnect?: SettingsNavText;
    extraFields?: SettingsNavText;
    coreAddon?: SettingsNavText;
    style?: SettingsNavText;
    declarative?: SettingsNavText;
  };
}

/** core 那幾區的 id 慣例:`core-<group>`(見 settings/page.tsx);其餘是擴充功能。 */
export function sectionArea(section: { id: string }): "core" | "extensions" {
  return section.id.startsWith("core-") ? "core" : "extensions";
}

export function settingsItemKey(area: SettingsArea, id: string): string {
  return `${area}:${id}`;
}

/** 每一區外框的 DOM id:`section-<id>`。別頁的連結用它當錨點,不能改。 */
export function sectionAnchorId(id: string): string {
  return `section-${id}`;
}

function fieldItem(section: SettingsNavSection, locale: Locale): SettingsNavItem {
  const area = sectionArea(section);
  return {
    key: settingsItemKey(area, section.id),
    id: section.id,
    area,
    kind: "fields",
    title: section.title,
    description: section.description ?? "",
    keywords: "",
    fields: section.fields.map((field) => {
      const fullKey = `${section.keyPrefix}${field.key}`;
      return {
        fullKey,
        controlId: settingControlId(fullKey),
        label: resolveLocalizedString(field.label, locale) ?? field.key,
        description: resolveLocalizedString(field.description, locale) ?? "",
      };
    }),
  };
}

function panelItem(area: SettingsArea, id: string, text: SettingsNavText): SettingsNavItem {
  return {
    key: settingsItemKey(area, id),
    id,
    area,
    kind: "panel",
    title: text.title,
    description: text.description ?? "",
    keywords: text.keywords ?? "",
    fields: [],
  };
}

function coreItems(input: SettingsNavInput): SettingsNavItem[] {
  const { panels, locale } = input;
  const groups = input.sections
    .filter((section) => sectionArea(section) === "core")
    .map((section) => fieldItem(section, locale));
  const aiConnect = panels.aiConnect ? [panelItem("core", AI_CONNECT_ID, panels.aiConnect)] : [];
  // AI 連線緊跟在 AI 設定後面;沒有 AI 那一區就排在其他核心設定之後。
  const ai = groups.findIndex((item) => item.id === AI_SECTION_ID);
  const cut = ai === -1 ? groups.length : ai + 1;
  return [
    ...groups.slice(0, cut),
    ...aiConnect,
    ...groups.slice(cut),
    ...(panels.extraFields ? [panelItem("core", EXTRA_FIELDS_ID, panels.extraFields)] : []),
    ...(panels.coreAddon ? [panelItem("core", CORE_ADDON_ID, panels.coreAddon)] : []),
  ];
}

/** 左邊清單的全部內容,照原本四個分頁的順序;沒有東西的分類不出現。 */
export function buildSettingsNav(input: SettingsNavInput): SettingsNavGroup[] {
  const { panels, locale } = input;
  const items: Record<SettingsArea, SettingsNavItem[]> = {
    core: coreItems(input),
    style: panels.style ? [panelItem("style", STYLE_ID, panels.style)] : [],
    declarative: panels.declarative ? [panelItem("declarative", DECLARATIVE_ID, panels.declarative)] : [],
    extensions: input.sections
      .filter((section) => sectionArea(section) === "extensions")
      .map((section) => fieldItem(section, locale)),
  };
  return SETTINGS_AREAS.filter((area) => items[area].length > 0).map((area) => ({
    area,
    label: input.areaLabels[area],
    items: items[area],
  }));
}

export function flattenSettingsNav(groups: readonly SettingsNavGroup[]): SettingsNavItem[] {
  return groups.flatMap((group) => group.items);
}

function areaOf(tab: string | null | undefined): SettingsArea | null {
  return SETTINGS_AREAS.find((area) => area === tab) ?? null;
}

function findInArea(
  groups: readonly SettingsNavGroup[],
  area: SettingsArea,
  id: string,
): SettingsNavItem | null {
  const group = groups.find((entry) => entry.area === area);
  return group?.items.find((item) => item.id === id) ?? null;
}

/** id 對到哪一區:先找指定的分類(沒指定就是核心),再找全部。 */
function findSection(
  groups: readonly SettingsNavGroup[],
  tab: string | null | undefined,
  id: string,
): SettingsNavItem | null {
  return (
    findInArea(groups, areaOf(tab) ?? "core", id) ??
    flattenSettingsNav(groups).find((item) => item.id === id) ??
    null
  );
}

export interface SettingsSelectionQuery {
  tab?: string | null;
  section?: string | null;
}

/**
 * 網址的 ?tab= 與 ?section= 對到清單上的哪一區。
 * 只有 tab(舊連結)→ 那個分類的第一區;tab 不認得或那個分類沒東西 → 核心的第一區。
 */
export function resolveSettingsSelection(
  groups: readonly SettingsNavGroup[],
  query: SettingsSelectionQuery,
): SettingsNavItem | null {
  if (query.section) {
    const hit = findSection(groups, query.tab, query.section);
    if (hit) return hit;
  }
  const area = areaOf(query.tab) ?? "core";
  const group = groups.find((entry) => entry.area === area) ?? groups[0];
  return group?.items[0] ?? null;
}

export interface SettingsFieldTarget {
  item: SettingsNavItem;
  field: SettingsNavField;
}

/** 用完整的設定 key 找到它在哪一區。 */
export function findSettingsField(
  groups: readonly SettingsNavGroup[],
  fullKey: string,
): SettingsFieldTarget | null {
  for (const item of flattenSettingsNav(groups)) {
    const field = item.fields.find((entry) => entry.fullKey === fullKey);
    if (field) return { item, field };
  }
  return null;
}

export interface SettingsHashTarget {
  item: SettingsNavItem;
  field?: SettingsNavField;
}

/**
 * 網址的 # 對到哪一區:`#section-<id>`(別頁既有的連結)或某個欄位輸入框的 id。
 * 不認得就回 null,照 ?tab= / ?section= 走。
 */
export function resolveSettingsHash(
  groups: readonly SettingsNavGroup[],
  hash: string,
  tab?: string | null,
): SettingsHashTarget | null {
  const target = hash.replace(/^#/, "");
  if (!target) return null;
  const prefix = sectionAnchorId("");
  if (target.startsWith(prefix)) {
    const item = findSection(groups, tab, target.slice(prefix.length));
    return item ? { item } : null;
  }
  for (const item of flattenSettingsNav(groups)) {
    const field = item.fields.find((entry) => entry.controlId === target);
    if (field) return { item, field };
  }
  return null;
}

/** 選到這一區時網址上的參數(null = 不帶)。核心是預設不帶 tab,分類的第一區不帶 section。 */
export function settingsSelectionParams(
  groups: readonly SettingsNavGroup[],
  item: SettingsNavItem,
): { tab: string | null; section: string | null } {
  const first = groups.find((group) => group.area === item.area)?.items[0];
  return {
    tab: item.area === "core" ? null : item.area,
    section: first?.key === item.key ? null : item.id,
  };
}

export function settingsHref(
  groups: readonly SettingsNavGroup[],
  item: SettingsNavItem,
  pathname: string = SETTINGS_PATH,
): string {
  const { tab, section } = settingsSelectionParams(groups, item);
  const params = new URLSearchParams();
  if (tab) params.set("tab", tab);
  if (section) params.set("section", section);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

// ---- 清單上的標記 ----

export type SettingsValues = Readonly<Record<string, string | boolean>>;

export interface SettingsNavStatus {
  /** 這一區有改過還沒儲存的欄位。 */
  unsaved: boolean;
  /** 這一區有必填欄位是空的。 */
  attention: boolean;
  /** 這一區有儲存時被退回的欄位。 */
  error: boolean;
}

export const NO_SETTINGS_STATUS: SettingsNavStatus = { unsaved: false, attention: false, error: false };

export interface SettingsStatusInput {
  sections: readonly SettingsNavSection[];
  /** 畫面上現在的值。 */
  state: SettingsValues;
  /** 上次儲存後的值(密鑰欄位永遠是空字串)。 */
  baseline: SettingsValues;
  /** 伺服器給的值;存過的密鑰是遮罩字元。 */
  saved: Readonly<Record<string, unknown>>;
  /** 完整 key → 儲存時伺服器退回的錯誤碼。 */
  fieldErrors: Readonly<Record<string, string>>;
}

/** 伺服器把存過的密鑰遮成這個字串(lib/settings.ts 的 SECRET_MASK)。 */
const SECRET_MASK = "•••";

/** 欄位現在在畫面上、而且可以填(同 SettingsWorkspace 畫欄位時的 showWhen / enabledWhen)。 */
function isFillable(section: SettingsNavSection, field: SettingField, state: SettingsValues): boolean {
  const { showWhen, enabledWhen } = field;
  if (showWhen && state[`${section.keyPrefix}${showWhen.key}`] !== showWhen.equals) return false;
  if (!enabledWhen) return true;
  const controller = state[`${section.keyPrefix}${enabledWhen.key}`];
  return enabledWhen.oneOf.some((allowed) => allowed === controller);
}

function isMissingRequired(
  section: SettingsNavSection,
  field: SettingField,
  input: SettingsStatusInput,
): boolean {
  // 開關沒有「空的」:關著也是一個值。
  if (!field.required || field.type === "boolean") return false;
  if (!isFillable(section, field, input.state)) return false;
  const fullKey = `${section.keyPrefix}${field.key}`;
  const value = input.state[fullKey];
  if (typeof value === "string" && value.trim().length > 0) return false;
  // 存過的密鑰不會回到畫面上,輸入框是空的不代表沒設定。
  return !(field.secret && input.saved[fullKey] === SECRET_MASK);
}

/** 每一區(key 是清單項目的 key)要不要加標記。只有進整頁表單的區會出現在結果裡。 */
export function settingsSectionStatus(input: SettingsStatusInput): Record<string, SettingsNavStatus> {
  return Object.fromEntries(
    input.sections.map((section) => {
      const keys = section.fields.map((field) => `${section.keyPrefix}${field.key}`);
      const status: SettingsNavStatus = {
        unsaved: keys.some((key) => input.state[key] !== input.baseline[key]),
        attention: section.fields.some((field) => isMissingRequired(section, field, input)),
        error: keys.some((key) => Boolean(input.fieldErrors[key])),
      };
      return [settingsItemKey(sectionArea(section), section.id), status];
    }),
  );
}

// ---- 帳戶頁的連結 ----

/**
 * 清單最後連到帳戶頁的那一項。extraKeywords 是網站上已啟用的登入方式的名字
 * (由設定頁帶進來),所以打登入服務的名字也找得到,核心不必寫死任何一家。
 */
export function accountSettingsLink(
  text: Required<SettingsNavText>,
  extraKeywords: readonly string[] = [],
): SettingsNavLink {
  const extra = [...new Set(extraKeywords.map((word) => word.trim()).filter(Boolean))];
  return {
    id: "account",
    title: text.title,
    description: text.description,
    keywords: [text.keywords, ...extra].filter(Boolean).join(" "),
    href: ACCOUNT_LINK_HREF,
  };
}
