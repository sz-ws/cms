import type { Locale } from "./index";

// spec-extension-i18n.md (Option A):declarative extension 的 manifest 使用者可見
// 字串,從單一「無語言意識」的 plain string 擴成「plain string | per-locale 物件」
// 的 inline union(LocalizedString)。舊 manifest 的純字串仍是 union 的第一分支、
// 完全合法(= 所有 locale 都用這一句);作者只在想翻的站點寫物件形式。
//
// 這個模組刻意是「純資料 + 純函式」:只 `import type` 一個 Locale(編譯期抹除,
// 零 runtime import)。因此它在 server(interpret / views / dashboard /
// type-directory 的 workers-pool)與 client(SettingsWorkspace / FormView)兩邊
// 都安全,不會把任何 client 依賴鏈拉進 server-safe 檔(見 type-directory.ts 檔頭
// 對 workers-pool 地雷的說明)。zod schema(localizedString union)住在
// src/ext/dx/manifest.ts;所有「消費端」一律走本檔的 resolveLocalizedString。

/** plain string(= 無語言意識,現況)或 per-locale 物件(至少一鍵,由 zod refine 保證)。 */
export type LocalizedString = string | { en?: string; "zh-Hant"?: string };

/**
 * 把一個 LocalizedString(或 undefined)解析成當前 locale 的顯示字串。
 *
 * Fallback 鏈(spec §4 / open-question #3 由 Suko 拍板):
 *   請求的 locale → `en` → 物件內任一鍵 → undefined。
 * 「任一鍵」保底確保:即使某 extension 只翻了 zh-Hant、沒給 en,`en`-locale 的
 * 使用者也看得到 zh-Hant 值,而永遠不會露出機器 key。
 *
 * plain string 原樣回傳(現況單語言行為,與 locale 無關)。undefined 入 → undefined
 * 出(讓呼叫端沿用既有的 `?? field.key` / `?? ct.name` fallback)。
 */
export function resolveLocalizedString(
  value: LocalizedString | undefined,
  locale: Locale,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const requested = value[locale];
  if (requested !== undefined) return requested;
  if (value.en !== undefined) return value.en;
  for (const v of Object.values(value)) {
    if (typeof v === "string") return v;
  }
  return undefined;
}

// 每一種後台語言各一格:Locale 多一種時這裡編譯不過,比對不會漏掉那一種。
const EVERY_LOCALE: Record<Locale, true> = { en: true, "zh-Hant": true };

/**
 * 1.62.0:兩個 LocalizedString 在每一種後台語言解析出來都一樣嗎。照 resolveLocalizedString 比,所以物件的
 * key 順序、純字串與每種語言同一句的物件都不影響。
 */
export function sameLocalizedString(a: LocalizedString | undefined, b: LocalizedString | undefined): boolean {
  return (Object.keys(EVERY_LOCALE) as Locale[]).every((locale) => resolveLocalizedString(a, locale) === resolveLocalizedString(b, locale));
}
