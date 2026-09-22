import type { SettingField } from "@/lib/settings";
import { CORE_API_VERSION } from "../version";

// 1.49.0:商品目錄是 commerce-kit 的一部分,不再是 registry 上的插件。
//
// 之前它是獨立的宣告式插件(sz-ws/registry 的 catalog 0.2.0),但底座的結帳
// (checkout.ts 預設讀 catalog.product)、商店、商城營運都讀它的型別 —— 底座依賴
// 一個各自發版的外部插件,改一個欄位就要各站跟著修,而且可以只裝商店不裝它
// (商品頁整個空白)。現在 manifest 跟底座一起發版,版本就是 CORE_API_VERSION。
//
// 資料面不變:它仍是 declarative_extensions 裡 id 為 catalog 的一列,讀
// manifest 的地方(型別目錄、relation、內容快取、agent 工具……)一行都不用改。
// 那一列由 ../builtin-declaratives.ts 依下面的 wanted() 對齊,後台不能安裝、
// 更新、停用或移除它;開關是商店設定裡的「商品目錄」。

export const CATALOG_EXT_ID = "catalog";
/** 用到 commerce-kit 的店面。它沒啟用,商品目錄就不啟用。 */
export const CATALOG_HOST_EXT = "shop";
/** 開關掛在店面的設定裡:ext.shop.catalog。 */
export const CATALOG_SETTING_KEY = "catalog";

export const CATALOG_SETTINGS: SettingField[] = [
  {
    key: CATALOG_SETTING_KEY,
    label: { en: "Product catalog", "zh-Hant": "商品目錄" },
    description: {
      en: "Products and categories in the admin, and the public product pages at /products. Turn it off to hide them; products and categories you have added are kept.",
      "zh-Hant": "後台的商品、分類頁，和前台的商品頁（/products）。關掉後這些頁面會收起來，已建立的商品和分類都會保留。",
    },
    type: "boolean",
    default: true,
  },
];

export interface CatalogWantedContext {
  codeEnabled: ReadonlySet<string>;
  setting: (key: string) => Promise<unknown>;
}

/** 店面啟用、而且開關沒被關掉。只有店面啟用時才去讀設定。 */
export async function catalogWanted(ctx: CatalogWantedContext): Promise<boolean> {
  if (!ctx.codeEnabled.has(CATALOG_HOST_EXT)) return false;
  const value = await ctx.setting(`ext.${CATALOG_HOST_EXT}.${CATALOG_SETTING_KEY}`);
  return value !== false;
}

const text = (en: string, zh: string) => ({ en, "zh-Hant": zh });

/** 商品目錄的宣告式 manifest。版本跟著底座。 */
export function catalogManifest(): Record<string, unknown> {
  return {
    kind: "declarative",
    id: CATALOG_EXT_ID,
    name: text("Catalog", "商品目錄"),
    version: CORE_API_VERSION,
    coreApi: `^${CORE_API_VERSION}`,
    description: text(
      "Products with price, image and a category picked from the category list, plus public list and detail pages.",
      "商品含價格、圖片，分類從分類清單挑選，並有公開的商品列表與詳情頁。",
    ),
    icon: "package",
    // 側欄「商務」一區,排在商店(order 20)前面。
    menu: { section: "commerce", order: 10 },
    contentTypes: [
      {
        name: "product",
        label: text("Product", "商品"),
        slugField: "name",
        fields: [
          { key: "name", type: "text", required: true, label: text("Name", "商品名稱") },
          { key: "slug", type: "slug", label: "Slug" },
          { key: "price", type: "number", label: text("Price (whole units)", "價格（整數）") },
          { key: "image", type: "media", label: text("Image", "商品圖") },
          { key: "category", type: "relation", to: "catalog.category", label: text("Category", "分類") },
          { key: "summary", type: "text", label: text("Summary", "一句話簡介") },
          { key: "body", type: "richtext", label: text("Description", "商品說明") },
        ],
        layout: {
          kind: "manual",
          groups: [
            { fields: ["name"] },
            { fields: ["slug", "category"] },
            { fields: ["price"] },
            { fields: ["summary"], fullWidth: true },
            { fields: ["image"], fullWidth: true },
            { fields: ["body"], fullWidth: true },
          ],
          wide: [],
        },
      },
      {
        name: "category",
        label: text("Category", "分類"),
        slugField: "name",
        fields: [
          { key: "name", type: "text", required: true, label: text("Name", "分類名稱") },
          { key: "slug", type: "slug", label: "Slug" },
        ],
      },
    ],
    settings: [
      {
        key: "currency",
        label: text("Currency", "幣別"),
        type: "select",
        options: [
          { value: "TWD", label: "TWD" },
          { value: "USD", label: "USD" },
          { value: "JPY", label: "JPY" },
        ],
        default: "TWD",
      },
      { key: "perPage", label: text("Products per page", "每頁商品數"), type: "number", default: 12 },
    ],
    adminPages: [
      { slug: "", title: text("Products", "商品"), view: "collection", contentType: "product", layout: "table" },
      { slug: "categories", title: text("Categories", "分類"), view: "collection", contentType: "category", layout: "table" },
    ],
    publicRoutes: [
      { pattern: "/products", view: "list", contentType: "product", layout: "grid" },
      { pattern: "/products/:slug", view: "detail", contentType: "product" },
    ],
  };
}
