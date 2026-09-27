import type { Locale } from "@/lib/i18n";
import { resolveLocalizedString, type LocalizedString } from "@/lib/i18n/localized";

// 1.58.0:registry 條目的名稱、簡介、重點、說明可以是字串或 { "zh-Hant", en }。
// GET /api/registry/index 依後台語系(core.locale)挑一句,商店拿到的一律是字串 ——
// 畫面、搜尋、付費與申請視窗都不必各自處理多語,也不可能印出 "[object Object]"。
// 挑法同 resolveLocalizedString:這個語系 → en → 物件裡任一個值。

export interface LocalizableEntryText {
  id: string;
  name: LocalizedString;
  description?: LocalizedString;
  highlights?: LocalizedString[];
  details?: LocalizedString;
}

export interface LocalizedEntryText {
  name: string;
  description?: string;
  highlights?: string[];
  details?: string;
}

export function localizeEntryText(entry: LocalizableEntryText, locale: Locale): LocalizedEntryText {
  const pick = (value: LocalizedString | undefined): string | undefined => {
    const text = typeof value === "string" || (value && typeof value === "object") ? resolveLocalizedString(value, locale) : undefined;
    return typeof text === "string" && text.trim().length > 0 ? text : undefined;
  };
  const highlights = Array.isArray(entry.highlights)
    ? entry.highlights.map(pick).filter((line): line is string => line !== undefined)
    : [];
  return {
    // 名稱挑不出來(理論上 registry-client 已擋掉)就用 id,永遠不是空白。
    name: pick(entry.name) ?? entry.id,
    description: pick(entry.description),
    highlights: highlights.length > 0 ? highlights : undefined,
    details: pick(entry.details),
  };
}
