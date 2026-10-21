import { getSetting } from "@/lib/settings";
import { parseShippingConfig } from "@/ext/commerce-kit/shipping";
import { shippingRegions } from "@/ext/commerce-kit/shipping-engine";

/**
 * 0.14.0:結帳表單「收件地區」的選項(運費設定的地區,和結帳頁同一個 parse;沒設運費 = 結帳頁沒有這一格,回空陣列)。
 * 別的插件要讓人先選好地區時(例如會員資料頁)用它,選項和結帳頁一樣。
 */
export async function shopShippingRegions(): Promise<readonly string[]> {
  const config = parseShippingConfig(await getSetting<string>("ext.shop.shippingConfig", ""));
  return config ? shippingRegions(config) : [];
}
