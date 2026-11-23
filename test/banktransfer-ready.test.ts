import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 銀行轉帳 0.3.0(core 2.1.0 PaymentProvider.checkReady):收款帳戶(銀行名稱、帳號、戶名)沒填好時,
// 在訂單成立之前就回答 not_configured。和 createCheckout 的付款指示讀同一份帳戶,兩邊的答案不會不一樣。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
// banktransfer 的後台頁會帶進 next/*,在 workers 測試池裡載不起來,換成最小的替身。
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => undefined, redirect: () => undefined, notFound: () => undefined }));
vi.mock("@/lib/units-server", () => ({ getSiteCurrency: async () => "TWD" }));

import { banktransfer } from "../extensions/banktransfer";
import { db } from "../src/lib/db";
import type { PaymentProvider } from "../src/ext/capabilities";
import type { CoreServices } from "../src/ext/services";

const d1 = () => (env as { DB: D1Database }).DB;
const ACCOUNT = {
  "ext.banktransfer.bankName": "測試銀行",
  "ext.banktransfer.bankCode": "999",
  "ext.banktransfer.accountNumber": "123-456",
  "ext.banktransfer.accountName": "測試戶名",
};
const NOT_CONFIGURED = { ok: false, error: "not_configured" };
const settings: { values: Record<string, unknown> } = { values: {} };

/** 結帳拿到的那個 provider(banktransfer 的 provides);設定讀這個測試的 settings.values。 */
function paymentProvider(): PaymentProvider {
  const services = {
    db: db(),
    settings: { get: async (key: string, fallback: unknown) => (key in settings.values ? settings.values[key] : fallback) },
  } as unknown as CoreServices;
  return banktransfer.provides![0].create(services) as PaymentProvider;
}
const request = (orderNo: string) => ({ orderNo, amount: 450, description: "測試商品 等 2 件", email: "buyer@example.com" });
const rows = () => d1().prepare("SELECT COUNT(*) AS n FROM ext_banktransfer_orders").first("n");

beforeAll(async () => {
  for (const statement of banktransfer.migrations![0].sql.split(";").map((s) => s.trim()).filter(Boolean)) await d1().prepare(statement).run();
});
beforeEach(async () => {
  settings.values = {};
  await d1().prepare("DELETE FROM ext_banktransfer_orders").run();
});

describe("banktransfer checkReady", () => {
  it("收款帳戶沒填 → not_configured,createCheckout 也是,不寫付款列", async () => {
    const provider = paymentProvider();
    expect(await provider.checkReady?.()).toEqual(NOT_CONFIGURED);
    expect(await provider.createCheckout(request("BT1"))).toEqual(NOT_CONFIGURED);
    expect(await rows()).toBe(0);
  });

  it.each(["bankName", "accountNumber", "accountName"])("少了 %s(或只有空白)→ not_configured", async (key) => {
    settings.values = { ...ACCOUNT, [`ext.banktransfer.${key}`]: "   " };
    expect(await paymentProvider().checkReady?.()).toEqual(NOT_CONFIGURED);
  });

  it("三個必填都有(銀行代碼可留空)→ ok,createCheckout 出示同一個帳戶", async () => {
    settings.values = { ...ACCOUNT, "ext.banktransfer.bankName": " 測試銀行 ", "ext.banktransfer.bankCode": "" };
    const provider = paymentProvider();
    expect(await provider.checkReady?.()).toEqual({ ok: true });
    // 問能不能收不會建付款列。
    expect(await rows()).toBe(0);
    const session = await provider.createCheckout(request("BT2"));
    expect(session).toMatchObject({ ok: true, kind: "manual", providerId: "banktransfer" });
    expect(session.ok && session.kind === "manual" ? session.instructions : []).toEqual(
      expect.arrayContaining([
        { label: "銀行", value: "測試銀行" },
        { label: "帳號", value: "123-456" },
        { label: "戶名", value: "測試戶名" },
      ]),
    );
    expect(await rows()).toBe(1);
  });

  it("有銀行代碼 → 付款指示寫在銀行名稱後面", async () => {
    settings.values = { ...ACCOUNT, "ext.banktransfer.bankCode": " 999 " };
    const session = await paymentProvider().createCheckout(request("BT3"));
    expect(session.ok && session.kind === "manual" ? session.instructions[0] : null).toEqual({ label: "銀行", value: "測試銀行（999）" });
  });
});
