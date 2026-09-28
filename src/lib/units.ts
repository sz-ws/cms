import { resolveLocalizedString, sameLocalizedString, type LocalizedString } from "./i18n/localized";
import type { Locale } from "./i18n";

// 1.62.0:一個數字的單位,與照單位寫出來的樣子(儀表板上插件的卡片、報表的圖)。純函式,server 與
// client 都能 import(client 元件拿到的是 Unit 這份資料,不是函式)。
//
//   count     件數、筆數:照後台語言分位(12,345.5)。
//   currency  金額:code 是 ISO 4217(TWD、USD、JPY);沒給 = 站台幣別(設定的 core.currency)。
//             符號一律用 en 的寫法(zh-TW 的新台幣符號只有 `$`,跟美元分不出來),符號與數字中間
//             空一格:NT$ 1,500、$ 12.50、¥ 3,000。整數不帶小數,非整數照幣別的位數。
//   quantity  有名字的量:3.5 點。label 可在地化,decimals 是最多幾位小數(去掉尾端的 0,預設 0)。
//   percent   百分比:值本身就是百分比(12.5 → 12.5%),最多一位小數。

export type Unit =
  | { kind: "count" }
  | { kind: "currency"; code?: string }
  | { kind: "quantity"; label: LocalizedString; decimals?: number }
  | { kind: "percent" };

/** 站台幣別的預設(core.currency 沒設時)。 */
export const DEFAULT_CURRENCY = "TWD";

/** 設定頁的幣別選項(core.currency)。 */
export const CURRENCY_OPTIONS: { value: string; label: { en: string; "zh-Hant": string } }[] = [
  { value: "TWD", label: { en: "New Taiwan dollar (TWD)", "zh-Hant": "新台幣（TWD）" } },
  { value: "USD", label: { en: "US dollar (USD)", "zh-Hant": "美元（USD）" } },
  { value: "JPY", label: { en: "Japanese yen (JPY)", "zh-Hant": "日圓（JPY）" } },
  { value: "HKD", label: { en: "Hong Kong dollar (HKD)", "zh-Hant": "港幣（HKD）" } },
  { value: "CNY", label: { en: "Chinese yuan (CNY)", "zh-Hant": "人民幣（CNY）" } },
  { value: "SGD", label: { en: "Singapore dollar (SGD)", "zh-Hant": "新加坡幣（SGD）" } },
  { value: "EUR", label: { en: "Euro (EUR)", "zh-Hant": "歐元（EUR）" } },
  { value: "GBP", label: { en: "British pound (GBP)", "zh-Hant": "英鎊（GBP）" } },
];

const CURRENCY_RE = /^[A-Z]{3}$/;
// Intl.NumberFormat 收任何三個字母的代碼(NTD 也不會錯),所以認得與否看執行環境列出的幣別。
const KNOWN_CURRENCIES: ReadonlySet<string> | null =
  typeof Intl.supportedValuesOf === "function" ? new Set(Intl.supportedValuesOf("currency")) : null;

/** 三個大寫字母、而且執行環境的 Intl 認得的 ISO 4217 幣別。 */
export function isCurrencyCode(value: unknown): value is string {
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) return false;
  return KNOWN_CURRENCIES ? KNOWN_CURRENCIES.has(value) : true;
}

/** 設定存的幣別 → 認得的代碼(小寫的 usd 當作 USD);不認得的用 fallback。 */
export function normalizeCurrency(value: unknown, fallback: string = DEFAULT_CURRENCY): string {
  const code = typeof value === "string" ? value.toUpperCase() : value;
  return isCurrencyCode(code) ? code : fallback;
}

/** 金額沒指定幣別時補上站台幣別;其他單位原樣。 */
export function resolveUnit(unit: Unit, siteCurrency: string): Unit {
  return unit.kind === "currency" && unit.code === undefined ? { kind: "currency", code: siteCurrency } : unit;
}

/** 兩個單位寫出來會不會一樣(同一個 metric 被宣告兩次時比對;名字照每種語言比)。 */
export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "currency" && b.kind === "currency") return a.code === b.code;
  if (a.kind === "quantity" && b.kind === "quantity") {
    return (a.decimals ?? 0) === (b.decimals ?? 0) && sameLocalizedString(a.label, b.label);
  }
  return true;
}

export const localeTag = (locale: Locale): string => (locale === "zh-Hant" ? "zh-TW" : "en-US");

const NUMBER_PARTS = new Set(["integer", "group", "decimal", "fraction", "nan", "infinity"]);

function formatCurrency(value: number, code: string): string {
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: Number.isInteger(value) ? 0 : undefined,
    }).formatToParts(value);
    // 符號與數字之間空一格(NT$ 1,500),符號在數字前或後都一樣。
    return parts
      .map((part, i) => {
        if (part.type !== "currency") return part.value;
        const before = NUMBER_PARTS.has(parts[i - 1]?.type ?? "") ? " " : "";
        const after = NUMBER_PARTS.has(parts[i + 1]?.type ?? "") ? " " : "";
        return `${before}${part.value}${after}`;
      })
      .join("");
  } catch {
    return `${code} ${value}`;
  }
}

/** 照單位寫出一個數字。siteCurrency:沒指定幣別的金額用它(省略 = DEFAULT_CURRENCY)。 */
export function formatUnit(value: number, unit: Unit, locale: Locale, siteCurrency: string = DEFAULT_CURRENCY): string {
  const tag = localeTag(locale);
  switch (unit.kind) {
    case "currency":
      return formatCurrency(value, unit.code ?? siteCurrency);
    case "quantity": {
      const number = new Intl.NumberFormat(tag, { maximumFractionDigits: unit.decimals ?? 0 }).format(value);
      const label = resolveLocalizedString(unit.label, locale);
      return label ? `${number} ${label}` : number;
    }
    case "percent":
      return `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value)}%`;
    default:
      return new Intl.NumberFormat(tag).format(value);
  }
}

/** 軸上的短數字:1.2萬、12K(不帶單位)。 */
export function compactNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
