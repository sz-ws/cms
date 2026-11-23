import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.1.0:金流(gateway)這一側的 PaymentProvider.checkReady。kit 只在 adapter 有 checkReady 時才提供;
// 藍新的 adapter 用和 buildCheckout 同一份設定檢查回答(金鑰缺或長度不對 = not_configured)。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { createPaymentProvider } from "../src/ext/payment-kit/provider";
import type { PaymentGatewayAdapter } from "../src/ext/payment-kit/types";
import { createNewebPayAdapter } from "../extensions/newebpay/adapter";
import type { CoreServices } from "../src/ext/services";

const adapter: PaymentGatewayAdapter = {
  buildCheckout: async () => ({ ok: false, error: "not_configured" }),
  verifyCallback: async () => false,
  parseCallback: async () => null,
};
const provider = (extra: Partial<PaymentGatewayAdapter> = {}) =>
  createPaymentProvider({
    services: {} as CoreServices,
    adapter: { ...adapter, ...extra },
    providerId: "gatewaytest",
    table: "ext_gatewaytest_orders",
    mode: "notify",
  });

/** 只有 settings 的 services:adapter 讀設定,不碰別的。 */
const withSettings = (values: Record<string, unknown>) =>
  ({
    settings: { get: async (key: string, fallback: unknown) => (key in values ? values[key] : fallback) },
  }) as unknown as CoreServices;

describe("gateway provider checkReady", () => {
  it("adapter 有 checkReady → 原樣回答", async () => {
    const notReady = { ok: false as const, error: "not_configured" };
    expect(await provider({ checkReady: async () => notReady }).checkReady?.()).toEqual(notReady);
    expect(await provider({ checkReady: async () => ({ ok: true }) }).checkReady?.()).toEqual({ ok: true });
  });

  it("adapter 沒有 checkReady → provider 也沒有", () => {
    expect(provider().checkReady).toBeUndefined();
  });
});

describe("newebpay adapter checkReady", () => {
  const keys = {
    "ext.newebpay.merchantId": "MS300000001",
    "ext.newebpay.hashKey": "abcdefghijklmnopqrstuvwxyz123456",
    "ext.newebpay.hashIv": "1234567890123456",
  };

  it("金鑰齊全 → ok", async () => {
    expect(await createNewebPayAdapter(withSettings(keys)).checkReady?.()).toEqual({ ok: true });
  });

  it("金鑰沒填或長度不對 → not_configured(和 buildCheckout 同一個代碼)", async () => {
    const notConfigured = { ok: false, error: "not_configured" };
    expect(await createNewebPayAdapter(withSettings({})).checkReady?.()).toEqual(notConfigured);
    expect(await createNewebPayAdapter(withSettings({ ...keys, "ext.newebpay.hashIv": "short" })).checkReady?.()).toEqual(notConfigured);
  });
});
