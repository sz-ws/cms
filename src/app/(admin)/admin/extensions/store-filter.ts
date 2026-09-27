import type { MessageKey } from "@/lib/i18n";
import { isStoreCategory, type StoreCategory } from "@/ext/store-categories";
import type { RegistryEntry } from "./registry-types";

// 1.58.0:商店的分類導覽與篩選(純函式,畫面與測試共用)。
//
// 分類是主要的導覽:只列有插件的分類,附數量。registry 帶來不認得的分類(或沒寫)的插件
// 歸在「其他」,所以每個插件都找得到;原始的分類字串永遠不上畫面。
// 「已安裝」是另外一個開關,標籤是第三個條件 —— 三者與搜尋同時成立。

export type CategoryKey = StoreCategory | "other";
export type CategoryFilter = CategoryKey | "all";

/** 導覽的順序:店家最常找的在前。 */
export const CATEGORY_ORDER: readonly CategoryKey[] = [
  "commerce",
  "marketing",
  "auth",
  "content",
  "media",
  "analytics",
  "integration",
  "utility",
  "theme",
  "other",
];

const CATEGORY_MESSAGE: Record<CategoryFilter, MessageKey> = {
  all: "registryBrowser.category.all",
  content: "registryBrowser.category.content",
  media: "registryBrowser.category.media",
  commerce: "registryBrowser.category.commerce",
  integration: "registryBrowser.category.integration",
  utility: "registryBrowser.category.utility",
  theme: "registryBrowser.category.theme",
  auth: "registryBrowser.category.auth",
  marketing: "registryBrowser.category.marketing",
  analytics: "registryBrowser.category.analytics",
  other: "registryBrowser.category.other",
};

/** 卡片上最多幾個標籤(詳情頁列全部)。 */
export const CARD_TAG_LIMIT = 3;

export function categoryKey(category: string | undefined): CategoryKey {
  return isStoreCategory(category) ? category : "other";
}

/** 分類的顯示名稱;不認得的值一律是「其他」。 */
export function categoryLabel(t: (key: MessageKey) => string, category: string | undefined): string {
  if (category === "all") return t(CATEGORY_MESSAGE.all);
  return t(CATEGORY_MESSAGE[categoryKey(category)]);
}

export interface CategoryCount {
  key: CategoryKey;
  count: number;
}

/** 有插件的分類與數量,依 CATEGORY_ORDER。 */
export function categoryCounts(entries: readonly RegistryEntry[]): CategoryCount[] {
  const counts = new Map<CategoryKey, number>();
  for (const entry of entries) {
    const key = categoryKey(entry.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return CATEGORY_ORDER.filter((key) => counts.has(key)).map((key) => ({ key, count: counts.get(key) ?? 0 }));
}

export interface StoreFilter {
  category: CategoryFilter;
  tag: string | null;
  query: string;
  installedOnly: boolean;
}

export const NO_FILTER: StoreFilter = { category: "all", tag: null, query: "", installedOnly: false };

export function isFiltered(filter: StoreFilter): boolean {
  return filter.category !== "all" || filter.tag !== null || filter.query.trim() !== "" || filter.installedOnly;
}

function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 依分類、標籤、已安裝與搜尋字篩選。搜尋比對名稱、id、簡介、標籤與分類的顯示名稱
 * (搜「電商」找得到 commerce 的插件)。
 */
export function filterEntries(
  entries: readonly RegistryEntry[],
  filter: StoreFilter,
  labelOf: (category: string | undefined) => string,
): RegistryEntry[] {
  const q = filter.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter.category !== "all" && categoryKey(e.category) !== filter.category) return false;
    if (filter.installedOnly && !e.installed) return false;
    if (filter.tag !== null && !e.tags?.some((tag) => sameTag(tag, filter.tag as string))) return false;
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      (e.description?.toLowerCase().includes(q) ?? false) ||
      (e.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false) ||
      labelOf(e.category).toLowerCase().includes(q)
    );
  });
}

/** 詳情頁的說明:空一行分段,空白段落丟掉。 */
export function detailParagraphs(details: string | undefined): string[] {
  if (!details) return [];
  return details
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
