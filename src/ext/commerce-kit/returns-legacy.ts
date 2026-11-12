/**
 * @deprecated 1.63.0 — remove in a later major version.
 *
 * 1.50.0 的退貨 API 用固定的 provider id 找庫存。1.63.0 起用 ProviderRegistry.find()
 * 找 capability "inventory" 裡唯一一個 RestockProvider(returns.ts 的 isRestockProvider),
 * 不看 id。這個常數只留給還 import 它的程式碼,之後的主版本拿掉。
 */
export const RESTOCK_PROVIDER_ID = "inventory";
