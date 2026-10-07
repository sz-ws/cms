import type {
  SettingsArea,
  SettingsNavField,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsNavLink,
} from "./settings-nav";

// 設定頁的搜尋:在左邊清單裡篩出符合的區與欄位。純函式。
//
// 比對的是人看得到的字 —— 區的標題與說明、欄位的標題與說明,加上各區自己帶的搜尋用字。
// 不分大小寫,全形英數當半形,中文照打的字找。空白隔開的每個字都要出現;可以一個字在
// 區的標題、另一個在欄位(「郵件 金鑰」)。結果不重新排序:照清單原本的順序,
// 找的人看到的還是同一張清單,只是變短。
//
// 三個字母以內的英數(ai、api、seo、url)要落在單字開頭:不然打「ai」會把說明裡有
// email、domain 的欄位全找出來,真正的 AI 那一區反而排在後面。

export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

function tokensOf(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

const SHORT_LATIN = /^[a-z0-9]{1,3}$/;
const LATIN_CHAR = /[a-z0-9]/;

/** text(已經 normalize 過)裡有沒有這個字;短的英數只認單字開頭。 */
function hasToken(text: string, token: string): boolean {
  if (!SHORT_LATIN.test(token)) return text.includes(token);
  let at = text.indexOf(token);
  while (at !== -1) {
    if (at === 0 || !LATIN_CHAR.test(text[at - 1])) return true;
    at = text.indexOf(token, at + 1);
  }
  return false;
}

export interface SettingsFieldHit {
  field: SettingsNavField;
  /** 字出現在標題,還是只在說明裡(畫面上只有後者要把說明列出來)。 */
  matchedIn: "label" | "description";
}

export interface SettingsSearchHit {
  item: SettingsNavItem;
  /** 區本身(標題、說明、搜尋用字)就符合。 */
  sectionMatched: boolean;
  fields: SettingsFieldHit[];
}

export interface SettingsSearchGroup {
  area: SettingsArea;
  label: string;
  hits: SettingsSearchHit[];
}

export interface SettingsSearchResult {
  groups: SettingsSearchGroup[];
  links: SettingsNavLink[];
  /** 什麼都沒找到。 */
  empty: boolean;
}

function fieldHit(
  field: SettingsNavField,
  tokens: readonly string[],
  sectionText: string,
): SettingsFieldHit | null {
  const label = normalizeSearchText(field.label);
  const text = `${label} ${normalizeSearchText(field.description)}`;
  const inField = tokens.filter((token) => hasToken(text, token));
  // 至少一個字在欄位自己身上,其餘的可以落在所屬的區。
  if (inField.length === 0) return null;
  const elsewhere = tokens.filter((token) => !hasToken(text, token));
  if (!elsewhere.every((token) => hasToken(sectionText, token))) return null;
  return {
    field,
    matchedIn: inField.every((token) => hasToken(label, token)) ? "label" : "description",
  };
}

function itemHit(item: SettingsNavItem, tokens: readonly string[]): SettingsSearchHit | null {
  const sectionText = normalizeSearchText(`${item.title} ${item.description} ${item.keywords}`);
  const sectionMatched = tokens.every((token) => hasToken(sectionText, token));
  const fields = item.fields.flatMap((field) => {
    const hit = fieldHit(field, tokens, sectionText);
    return hit ? [hit] : [];
  });
  return sectionMatched || fields.length > 0 ? { item, sectionMatched, fields } : null;
}

function linkMatches(link: SettingsNavLink, tokens: readonly string[]): boolean {
  const text = normalizeSearchText(`${link.title} ${link.description} ${link.keywords}`);
  return tokens.every((token) => hasToken(text, token));
}

/** 沒打字(或只有空白)回 null:不篩選,顯示整張清單。 */
export function searchSettingsNav(
  groups: readonly SettingsNavGroup[],
  links: readonly SettingsNavLink[],
  query: string,
): SettingsSearchResult | null {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return null;
  const matchedGroups = groups
    .map((group) => ({
      area: group.area,
      label: group.label,
      hits: group.items.flatMap((item) => {
        const hit = itemHit(item, tokens);
        return hit ? [hit] : [];
      }),
    }))
    .filter((group) => group.hits.length > 0);
  const matchedLinks = links.filter((link) => linkMatches(link, tokens));
  return {
    groups: matchedGroups,
    links: matchedLinks,
    empty: matchedGroups.length === 0 && matchedLinks.length === 0,
  };
}

export type SettingsSearchTarget =
  | { kind: "item"; item: SettingsNavItem; field?: SettingsNavField }
  | { kind: "link"; link: SettingsNavLink };

/** 在搜尋框按 Enter 要去的地方:結果的第一筆(區本身符合就開那一區,否則開第一個符合的欄位)。 */
export function firstSearchTarget(result: SettingsSearchResult): SettingsSearchTarget | null {
  const hit = result.groups[0]?.hits[0];
  if (hit) {
    return hit.sectionMatched
      ? { kind: "item", item: hit.item }
      : { kind: "item", item: hit.item, field: hit.fields[0]?.field };
  }
  const link = result.links[0];
  return link ? { kind: "link", link } : null;
}
