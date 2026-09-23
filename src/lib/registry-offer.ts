import type { LocalizedString } from "@/lib/i18n/localized";
import { registryTextLength, sanitizeRegistryText } from "./registry-text";

// 付費插件協定 1(sz-ws/registry 的 README):registry.json 條目上的 offer 與 access。
//
//   offer  —— 營運者寫在 repo 的價格與說明。價格寫在索引、不寫進 manifest:沒開通的站
//             拿不到宣告式插件的 manifest,價格放在裡面就沒人看得到;同一份 manifest
//             也可能在不同 registry 有不同的價格。
//   access —— 閘道依這把金鑰即時加上的開通狀態。靜態 registry(GitHub raw)給不出來,
//             所以只有 access 在的時候 offer 才算數(見 registry-client 的 parseIndexEntries)。
//
// core 只顯示,不收錢、不驗授權:真正擋下未開通安裝的是送出 bytes 的閘道(manifest 與
// 檔案回 402)。這個模組是純資料 + 純函式,server 解析與商店畫面共用。

const ACCESS_STATES = ["granted", "locked", "requested", "expired"] as const;
export type RegistryAccess = (typeof ACCESS_STATES)[number];

const PRICE_PERIODS = ["once", "month", "year"] as const;
type PricePeriod = (typeof PRICE_PERIODS)[number];

interface OfferPrice {
  /** 以主幣別為單位(TWD 就是元)。 */
  amount: number;
  /** ISO 4217 三碼。core 不換匯。 */
  currency: string;
  period: PricePeriod;
}

export interface RegistryOffer {
  /** 可以省略,只寫 note(「依人數報價」)。 */
  price?: OfferPrice;
  /** 計價單位與包含項目,≤ 40 字,已消毒。 */
  note?: LocalizedString;
  action?: "request" | "link";
  /** action 為 link 時必填;https。 */
  url?: string;
  /** 條款頁;https。 */
  termsUrl?: string;
}

const NOTE_MAX = 40;
const URL_MAX = 2048;
const CURRENCY_RE = /^[A-Z]{3}$/;
const OFFER_ACTIONS = ["request", "link"] as const;

export function parseAccess(raw: unknown): RegistryAccess | undefined {
  return ACCESS_STATES.includes(raw as RegistryAccess) ? (raw as RegistryAccess) : undefined;
}

/** 只收 https(按鈕與連結不能被導向 javascript: 或明文 http)。 */
export function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > URL_MAX) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

// 不合格就整筆 offer 丟掉的欄位,用 INVALID 跟「沒寫」分開。
const INVALID = Symbol("invalid");

function parsePrice(raw: unknown): OfferPrice | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") return INVALID;
  const { amount, currency, period } = raw as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return INVALID;
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) return INVALID;
  if (!PRICE_PERIODS.includes(period as PricePeriod)) return INVALID;
  return { amount, currency, period: period as PricePeriod };
}

function noteText(raw: unknown): string | undefined | typeof INVALID {
  if (typeof raw !== "string") return INVALID;
  const text = sanitizeRegistryText(raw);
  if (registryTextLength(text) > NOTE_MAX) return INVALID;
  return text || undefined;
}

function parseNote(raw: unknown): LocalizedString | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return noteText(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return INVALID;
  const out: { en?: string; "zh-Hant"?: string } = {};
  for (const locale of ["en", "zh-Hant"] as const) {
    const value = (raw as Record<string, unknown>)[locale];
    if (value === undefined) continue;
    const text = noteText(value);
    if (text === INVALID) return INVALID;
    if (text !== undefined) out[locale] = text;
  }
  return out.en !== undefined || out["zh-Hant"] !== undefined ? out : undefined;
}

function optionalHttps(raw: unknown): string | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  return httpsUrl(raw) ?? INVALID;
}

/**
 * registry.json 的 offer → 驗證過的 RegistryOffer;不合格(網址不是 https、幣別不是三碼、
 * 週期不認得、note 超過 40 字、action 不認得、link 沒有網址)就整筆丟掉,回 undefined。
 * 丟掉之後 access 若仍是 locked,商店照樣顯示「尚未開通」—— 不會因為 offer 寫壞就變成安裝鈕。
 */
export function parseOffer(raw: unknown): RegistryOffer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const price = parsePrice(r.price);
  const note = parseNote(r.note);
  const url = optionalHttps(r.url);
  const termsUrl = optionalHttps(r.termsUrl);
  if (price === INVALID || note === INVALID || url === INVALID || termsUrl === INVALID) return undefined;
  if (r.action !== undefined && !OFFER_ACTIONS.includes(r.action as never)) return undefined;
  const action = r.action as RegistryOffer["action"];
  if (action === "link" && url === undefined) return undefined;
  return {
    ...(price ? { price } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(action ? { action } : {}),
    ...(url ? { url } : {}),
    ...(termsUrl ? { termsUrl } : {}),
  };
}

/** 這個站能不能裝、能不能更新:沒有 access(免費、靜態 registry)或已開通。 */
export function isEntitled(entry: { access?: RegistryAccess }): boolean {
  return entry.access === undefined || entry.access === "granted";
}

/**
 * 金額一律用 en 語系排版:NT$25,000、¥3,000、$12、$12.50。zh-TW 的 TWD 符號是單獨一個
 * `$`,跟美元分不出來,所以不跟後台語系。整數不帶小數;非整數照幣別的預設位數。
 */
export function formatPrice(price: Pick<OfferPrice, "amount" | "currency">): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: price.currency,
      minimumFractionDigits: Number.isInteger(price.amount) ? 0 : undefined,
    }).format(price.amount);
  } catch {
    return `${price.currency} ${price.amount}`;
  }
}
