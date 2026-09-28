import { getSetting } from "@/lib/settings";
import type { ProviderRegistry } from "@/ext/providers";
import { transferReportSpec } from "@/ext/payment-kit/manual";
import type { TransferReportSpec } from "@/ext/payment-kit/report-spec";

// 商店的頁面(server)要知道的 provider:這一次請求的 registry 與匯款方式要客人回報什麼(0.9.0)。
// 同 core 的 services.ts:getExtRuntime → buildProviderRegistry。動態 import,免得頁面模組一載入就
// 把整個 extension registry 拉進來。

export const TRANSFER_PROVIDER_KEY = "ext.shop.transferProvider";

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
export async function loadTransferReportSpec(
  providers?: Pick<ProviderRegistry, "getById">,
): Promise<TransferReportSpec> {
  const providerId = (await getSetting<string>(TRANSFER_PROVIDER_KEY, "")).trim();
  if (!providerId) return transferReportSpec(null);
  const registry = providers ?? (await shopProviders());
  return transferReportSpec(registry.getById<unknown>("payment", providerId));
}
