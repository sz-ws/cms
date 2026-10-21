import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { decryptTradeInfo, encryptTradeInfo, tradeSha } from "../extensions/newebpay/crypto";

// 0.2.0:同一張訂單再去付款(我的訂單的「前往安全付款頁」、刷卡失敗後再試)要用新的
// MerchantOrderNo —— 藍新同一商店的商店訂單編號不能重複(MPG03008)。回呼帶回的是
// 那次嘗試的號碼,要對回原本的訂單結算。

const HASH_KEY = "abcdefghijklmnopqrstuvwxyz123456";
const HASH_IV = "1234567890123456";
const MERCHANT_ID = "MS300000001";
// 商店的訂單編號:SM + 28 個英數,剛好是藍新的上限 30 字。
const ORDER_NO = "SM57E5373312B74BC2B168096F28A7";
const OTHER_ORDER = "SM57E5373312B74BC2B1FFFFFFFFFF";

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const settingsStore = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) =>
    key in settingsStore.values ? settingsStore.values[key] : fallback,
  setSettings: async (entries: Record<string, unknown>) => {
    Object.assign(settingsStore.values, entries);
  },
}));

vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => false }));

const hookEvents = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { newebpay } = await import("../extensions/newebpay");
  const hooks = new HookBus();
  hooks.register("test-observer", "payment:succeeded", (payload: unknown) => {
    hookEvents.events.push(payload);
  });
  const rt = {
    enabled: [newebpay],
    all: [newebpay],
    hooks,
    byId: (id: string) => (id === newebpay.id ? newebpay : undefined),
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { POST } from "../src/app/api/callback/[capability]/[providerId]/route";
import { db } from "../src/lib/db";
import { HookBus } from "../src/ext/hooks";
import { createPaymentProvider, PaymentReturn } from "../src/ext/payment-kit";
import { fill, SlotRegistry } from "../src/ext/slots";
import { createNewebPayAdapter } from "../extensions/newebpay/adapter";
import type { CoreServices } from "../src/ext/services";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

function provider(mode: "notify" | "return" = "notify", slots?: SlotRegistry) {
  const services = {
    db: db(),
    hooks: new HookBus(),
    slots,
    settings: {
      get: async (key: string, fallback?: unknown) =>
        key in settingsStore.values ? settingsStore.values[key] : fallback,
    },
  } as unknown as CoreServices;
  return createPaymentProvider({
    services,
    adapter: createNewebPayAdapter(services),
    providerId: "newebpay",
    table: "ext_newebpay_orders",
    mode,
  });
}

/** 一個認得 ORDER_NO 的插件(core 1.78.0 PaymentReturn);path 讓測試換成別的回答。 */
function shopClaims(path: (orderNo: string, outcome: string) => string | null) {
  return new SlotRegistry([{ extId: "shop-like", fills: [fill(PaymentReturn, (pages) => [...pages, { path }])] }]);
}

/** 送去藍新的那份表單裡的 MerchantOrderNo。 */
async function merchantOrderNoOf(orderNo: string): Promise<string> {
  const session = await provider().createCheckout({ orderNo, amount: 1950, description: "測試商品 等 12 件" });
  if (!session.ok || session.kind !== "form-post") throw new Error(`no form-post session: ${JSON.stringify(session)}`);
  const plain = await decryptTradeInfo(session.fields.TradeInfo, HASH_KEY, HASH_IV);
  return new URLSearchParams(plain ?? "").get("MerchantOrderNo") ?? "";
}

async function callbackBody(merchantOrderNo: string, status: "SUCCESS" | "MPG03009"): Promise<string> {
  const payload = {
    Status: status,
    Message: status === "SUCCESS" ? "授權成功" : "交易失敗",
    Result: { MerchantOrderNo: merchantOrderNo, TradeNo: "26102012345678", PaymentType: "CREDIT", PayTime: "2026-10-20 18:00:00", Amt: 1950 },
  };
  const tradeInfo = await encryptTradeInfo(JSON.stringify(payload), HASH_KEY, HASH_IV);
  return new URLSearchParams({ Status: status, MerchantID: MERCHANT_ID, Version: "2.0", TradeInfo: tradeInfo, TradeSha: await tradeSha(tradeInfo, HASH_KEY, HASH_IV) }).toString();
}

async function callback(merchantOrderNo: string, status: "SUCCESS" | "MPG03009"): Promise<Response> {
  return POST(
    new Request("https://cms.test/api/callback/payment/newebpay", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: await callbackBody(merchantOrderNo, status),
    }),
    { params: Promise.resolve({ capability: "payment", providerId: "newebpay" }) },
  );
}

async function status(orderNo: string): Promise<string | undefined> {
  const row = await d1().prepare("SELECT status FROM ext_newebpay_orders WHERE order_no = ?").bind(orderNo).first<{ status: string }>();
  return row?.status;
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS ext_newebpay_orders (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM ext_newebpay_orders;");
  settingsStore.values = {
    "ext.newebpay.merchantId": MERCHANT_ID,
    "ext.newebpay.hashKey": HASH_KEY,
    "ext.newebpay.hashIv": HASH_IV,
    "ext.newebpay.env": "test",
    "core.siteUrl": "https://shop.example",
  };
  hookEvents.events = [];
});

describe("NewebPay: every attempt at paying an order has its own MerchantOrderNo", () => {
  it("the first attempt uses the order number itself", async () => {
    expect(await merchantOrderNoOf(ORDER_NO)).toBe(ORDER_NO);
  });

  it("paying again uses a new number NewebPay accepts (30 characters at most, letters, digits and _)", async () => {
    const first = await merchantOrderNoOf(ORDER_NO);
    const second = await merchantOrderNoOf(ORDER_NO);
    const third = await merchantOrderNoOf(ORDER_NO);
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    for (const no of [second, third]) expect(no).toMatch(/^[A-Za-z0-9_]{1,30}$/);
  });

  it("a declined card, then a paid retry: the order is paid and the hook names the order, not the attempt", async () => {
    const first = await merchantOrderNoOf(ORDER_NO);
    expect((await callback(first, "MPG03009")).status).toBe(200);
    expect(await status(ORDER_NO)).toBe("failed");

    const retry = await merchantOrderNoOf(ORDER_NO);
    expect((await callback(retry, "SUCCESS")).status).toBe(200);
    expect(await status(ORDER_NO)).toBe("paid");
    expect(hookEvents.events).toEqual([expect.objectContaining({ providerId: "newebpay", orderNo: ORDER_NO })]);
  });

  it("a retry number never settles another order that shares the beginning of the order number", async () => {
    await merchantOrderNoOf(ORDER_NO);
    await merchantOrderNoOf(OTHER_ORDER);
    const retry = await merchantOrderNoOf(ORDER_NO);
    await callback(retry, "SUCCESS");
    expect(await status(ORDER_NO)).toBe("paid");
    expect(await status(OTHER_ORDER)).toBe("pending");
  });

  it("only credit card is offered on NewebPay's page (ATM and convenience-store codes are paid days later)", async () => {
    const session = await provider().createCheckout({ orderNo: ORDER_NO, amount: 1950, description: "測試商品 等 12 件" });
    if (!session.ok || session.kind !== "form-post") throw new Error("no form-post session");
    const plain = new URLSearchParams((await decryptTradeInfo(session.fields.TradeInfo, HASH_KEY, HASH_IV)) ?? "");
    expect(plain.get("CREDIT")).toBe("1");
    for (const other of ["VACC", "CVS", "BARCODE", "WEBATM"]) expect(plain.get(other)).toBeNull();
  });

  it("a callback padded the way NewebPay pads (32-byte blocks) settles the order", async () => {
    await merchantOrderNoOf(ORDER_NO);
    for (const [orderNo, extra] of [[ORDER_NO, 0], [ORDER_NO, 9]] as const) {
      const payload = JSON.stringify({ Status: "SUCCESS", Message: "授權成功", Result: { MerchantOrderNo: orderNo, TradeNo: "26102112345678", PaymentType: "CREDIT", PayTime: "2026-10-21 20:08:18", Amt: 1950 } }) + " ".repeat(extra);
      const bytes = new TextEncoder().encode(payload);
      const pad = 32 - (bytes.length % 32);
      const padded = new Uint8Array(bytes.length + pad);
      padded.set(bytes);
      padded.fill(pad, bytes.length);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(HASH_KEY), { name: "AES-CBC" }, false, ["encrypt"]);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: new TextEncoder().encode(HASH_IV) }, key, padded)).slice(0, padded.length);
      const tradeInfo = Array.from(sealed, (b) => b.toString(16).padStart(2, "0")).join("");
      const body = new URLSearchParams({ Status: "SUCCESS", MerchantID: MERCHANT_ID, Version: "2.0", TradeInfo: tradeInfo, TradeSha: await tradeSha(tradeInfo, HASH_KEY, HASH_IV) }).toString();
      const res = await POST(new Request("https://cms.test/api/callback/payment/newebpay", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }), { params: Promise.resolve({ capability: "payment", providerId: "newebpay" }) });
      expect(res.status).toBe(200);
    }
    expect(await status(ORDER_NO)).toBe("paid");
  });

  it("keys pasted with spaces around them still work", async () => {
    settingsStore.values["ext.newebpay.hashKey"] = ` ${HASH_KEY} `;
    settingsStore.values["ext.newebpay.merchantId"] = `${MERCHANT_ID}\n`;
    expect(await merchantOrderNoOf(ORDER_NO)).toBe(ORDER_NO);
  });

  it("a callback for a number no order matches settles nothing", async () => {
    await merchantOrderNoOf(ORDER_NO);
    await callback("SMFFFFFFFFFFFFFFFFFFFF_zz00000", "SUCCESS");
    expect(await status(ORDER_NO)).toBe("pending");
    expect(hookEvents.events).toHaveLength(0);
  });
});

describe("where the customer lands after NewebPay (core 1.78.0 PaymentReturn)", () => {
  const ours = (orderNo: string, outcome: string) => (orderNo === ORDER_NO ? `/shop/orders?order=${orderNo}&payment=${outcome}` : null);

  it("paid: a 303 to the page the order's plugin gives, and the order is paid", async () => {
    await merchantOrderNoOf(ORDER_NO);
    const res = await provider("return", shopClaims(ours)).handleCallback(await callbackBody(ORDER_NO, "SUCCESS"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(303);
    expect((res as Response).headers.get("location")).toBe(`https://shop.example/shop/orders?order=${ORDER_NO}&payment=paid`);
    expect(await status(ORDER_NO)).toBe("paid");
  });

  it("declined: the same page says failed (the retry number still maps back to the order)", async () => {
    await merchantOrderNoOf(ORDER_NO);
    const retry = await merchantOrderNoOf(ORDER_NO);
    const res = (await provider("return", shopClaims(ours)).handleCallback(await callbackBody(retry, "MPG03009"))) as Response;
    expect(res.headers.get("location")).toBe(`https://shop.example/shop/orders?order=${ORDER_NO}&payment=failed`);
  });

  it("no plugin claims the order, or it gives an address off the site: the plain result page as before", async () => {
    await merchantOrderNoOf(ORDER_NO);
    for (const slots of [undefined, shopClaims(() => null), shopClaims(() => "https://elsewhere.example/x"), shopClaims(() => "//elsewhere.example/x")]) {
      const res = (await provider("return", slots).handleCallback(await callbackBody(ORDER_NO, "SUCCESS"))) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("「返回商店」 on NewebPay's page goes to the order's page, or the home page when nobody claims it", async () => {
    const back = async (slots?: SlotRegistry) => {
      await d1().exec("DELETE FROM ext_newebpay_orders;");
      const session = await provider("notify", slots).createCheckout({ orderNo: ORDER_NO, amount: 1950, description: "測試商品 等 12 件" });
      if (!session.ok || session.kind !== "form-post") throw new Error("no form-post session");
      return new URLSearchParams((await decryptTradeInfo(session.fields.TradeInfo, HASH_KEY, HASH_IV)) ?? "").get("ClientBackURL");
    };
    expect(await back(shopClaims(ours))).toBe(`https://shop.example/shop/orders?order=${ORDER_NO}&payment=back`);
    expect(await back()).toBe("https://shop.example");
  });
});

describe("a signed callback whose content cannot be read (core 1.78.1)", () => {
  // TradeSha 是對密文算的:簽章對、內容解不開(例如以前 32 bytes 一塊的填充)時,我們不知道付了沒有。
  async function unreadableBody(): Promise<string> {
    const tradeInfo = "00".repeat(32);
    return new URLSearchParams({ Status: "SUCCESS", MerchantID: MERCHANT_ID, Version: "2.0", TradeInfo: tradeInfo, TradeSha: await tradeSha(tradeInfo, HASH_KEY, HASH_IV) }).toString();
  }

  it("the browser page does not say no money was taken; it says the result is being checked", async () => {
    const res = (await provider("return").handleCallback(await unreadableBody())) as Response;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("未收取任何款項");
    expect(html).toContain("付款結果確認中");
  });

  it("the server-to-server notice answers 500, so the failure is not acknowledged as received", async () => {
    const res = await provider("notify").handleCallback(await unreadableBody());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
  });
});
