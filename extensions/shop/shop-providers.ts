import { getSetting } from "@/lib/settings";
import type { ProviderRegistry } from "@/ext/providers";
import { transferReportSpec } from "@/ext/payment-kit/manual";
import type { TransferReportSpec } from "@/ext/payment-kit/report-spec";
import {
  listCheckoutFields,
  publicCheckoutFields,
  type PublicCheckoutField,
} from "@/ext/commerce-kit/checkout-fields";

// 商店的頁面(server)要問 provider 的事(0.9.0):這一次請求的 registry、匯款方式要客人回報什麼、
// 插件宣告的結帳欄位。同 core 的 services.ts:getExtRuntime → buildProviderRegistry。動態 import,
// 免得頁面模組一載入就把整個 extension registry 拉進來。

export const TRANSFER_PROVIDER_KEY = "ext.shop.transferProvider";

type Registry = Pick<ProviderRegistry, "getById" | "list">;

/** 這一次請求的 provider registry(已啟用的插件)。 */
export async function shopProviders(): Promise<ProviderRegistry> {
  const [{ getExtRuntime }, { buildProviderRegistry }] = await Promise.all([
    import("@/ext/loader"),
    import("@/ext/services"),
  ]);
  return buildProviderRegistry(await getExtRuntime());
}

/**
 * 商店的匯款方式(設定 ext.shop.transferProvider)要客人回報什麼。沒設匯款方式、那個插件沒啟用、
 * 或它沒說 → 預設(帳號末五碼)。
 */
export async function loadTransferReportSpec(providers?: Registry): Promise<TransferReportSpec> {
  const providerId = (await getSetting<string>(TRANSFER_PROVIDER_KEY, "")).trim();
  if (!providerId) return transferReportSpec(null);
  const registry = providers ?? (await shopProviders());
  return transferReportSpec(registry.getById<unknown>("payment", providerId));
}

/** 插件宣告的結帳欄位(給結帳頁畫;label 是繁中)。 */
export async function loadCheckoutFields(providers?: Registry): Promise<PublicCheckoutField[]> {
  return publicCheckoutFields(await listCheckoutFields(providers ?? (await shopProviders())), "zh-Hant");
}

/** 訂單 meta 的名字 → 欄位名稱(後台訂單列表用;宣告它的插件停用了就沒有)。 */
export async function loadCheckoutFieldLabels(providers?: Registry): Promise<Record<string, string>> {
  const fields = await loadCheckoutFields(providers);
  return Object.fromEntries(fields.map((field) => [field.name, field.label]));
}
