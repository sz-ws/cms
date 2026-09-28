import { getSetting } from "@/lib/settings";
import { DEFAULT_CURRENCY, normalizeCurrency } from "@/lib/units";

// 1.62.0:server 端讀站台幣別(規則見 lib/units.ts)。

/** 站台幣別(settings 的 core.currency;沒設或壞值時是 DEFAULT_CURRENCY)。 */
export async function getSiteCurrency(): Promise<string> {
  return normalizeCurrency(await getSetting<string>("core.currency", DEFAULT_CURRENCY));
}
