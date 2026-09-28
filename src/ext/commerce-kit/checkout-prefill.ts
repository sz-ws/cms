// commerce-kit 1.63.0:結帳欄位的預先帶入(瀏覽器端)。插件在別的頁面記下一個值(例如連結上的
// ?ref=),結帳頁把同名欄位(`<providerId>.<key>`,見 checkout-fields.ts)先填好。存在 localStorage
// 的一個 key 底下,每個值有自己的到期時間。瀏覽器不讓存(無痕、停用)時什麼都不做 —— 帶入只是方便,
// 伺服器照樣檢查。沒有 React,server 端 import 也不會出錯(碰不到 localStorage 就當作沒有)。

export const CHECKOUT_PREFILL_KEY = "checkout.prefill.v1";
const DAY = 86_400_000;

type Stored = Record<string, { value: string; expiresAt: number }>;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load(now: number): Stored {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(CHECKOUT_PREFILL_KEY) ?? "null");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const kept: Stored = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const e = entry as { value?: unknown; expiresAt?: unknown } | null;
      if (e && typeof e.value === "string" && typeof e.expiresAt === "number" && e.expiresAt > now) {
        kept[name] = { value: e.value, expiresAt: e.expiresAt };
      }
    }
    return kept;
  } catch {
    return {};
  }
}

function save(stored: Stored): void {
  try {
    const store = storage();
    if (!store) return;
    if (Object.keys(stored).length === 0) store.removeItem(CHECKOUT_PREFILL_KEY);
    else store.setItem(CHECKOUT_PREFILL_KEY, JSON.stringify(stored));
  } catch {
    /* 瀏覽器不讓存:帶入只是方便 */
  }
}

/** 記下一個值,days 天後過期(預設 30 天)。同名的舊值被取代。 */
export function rememberCheckoutValue(name: string, value: string, options: { days?: number; now?: number } = {}): void {
  const now = options.now ?? Date.now();
  const days = options.days ?? 30;
  save({ ...load(now), [name]: { value, expiresAt: now + days * DAY } });
}

/** 記下的值;沒有或過期是 ""。 */
export function readCheckoutValue(name: string, now: number = Date.now()): string {
  return load(now)[name]?.value ?? "";
}

/** 忘掉一個值;給了 value 時只有記下的就是它才忘(伺服器拒絕的那一個)。 */
export function forgetCheckoutValue(name: string, value?: string, now: number = Date.now()): void {
  const stored = load(now);
  if (!(name in stored) || (value !== undefined && stored[name].value !== value)) return;
  save(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== name)));
}
