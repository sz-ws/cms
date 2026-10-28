import type { Extension } from "./types";

/** settings 裡記「上次自動套用完更新時,程式碼裡的插件長什麼樣」的 key。 */
export const CODE_SIGNATURE_KEY = "core.codeSignature";

/**
 * 程式碼裡每個插件的 id、版號與 migration id。部署了不同的插件組合、版號或 migration,
 * 簽名就不同,loader 才會去檢查要不要套用更新;相同就不多查任何東西。
 */
export function codeSignature(
  exts: readonly Pick<Extension, "id" | "version" | "migrations">[],
): string {
  return exts
    .map((ext) => `${ext.id}@${ext.version}:${(ext.migrations ?? []).map((m) => m.id).join(",")}`)
    .sort()
    .join("|");
}
