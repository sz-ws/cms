// 1.58.0:商店分類的唯一清單。manifest 的 `category` enum、商店的分類導覽與標籤都從這裡來。
// 純資料、零相依:manifest.ts(server)與 RegistryBrowser(client)都直接 import。
//
// registry 可能帶來這份清單以外的值(更新的 core、手寫的 registry.json):商店把它們
// 歸在 "other",顯示中性的「其他」,永遠不露出原始字串。

export const STORE_CATEGORIES = [
  "content",
  "media",
  "commerce",
  "integration",
  "utility",
  "theme",
  // 1.58.0 新增:用到這三個的 manifest 要宣告 coreApi "^1.58.0"(舊 core 的 enum 不認得)。
  "auth",
  "marketing",
  "analytics",
] as const;

export type StoreCategory = (typeof STORE_CATEGORIES)[number];

/** 1.58.0 才認得的分類(manifest 驗證用來要求 coreApi 下限)。 */
export const CATEGORIES_SINCE_1_58: readonly StoreCategory[] = ["auth", "marketing", "analytics"];

export function isStoreCategory(value: unknown): value is StoreCategory {
  return typeof value === "string" && (STORE_CATEGORIES as readonly string[]).includes(value);
}
