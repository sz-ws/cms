import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  encryptTradeInfo,
  tradeSha,
} from "../extensions/newebpay/crypto";

// 端到端:POST /api/callback/payment/{newebpay,newebpay-return} 走真實 unified
// ingress + 真實 NewebPayProvider + 真實 D1 訂單表(僅 settings/loader/rate-limit
// 以 mock 隔離)。覆蓋:
//   - 驗簽(403 壞簽章 / 未設定 fail-closed)
//   - notify:訂單 pending→paid、payment:succeeded hook、冪等(已 paid 不重複)
//   - return 模式:回 HTML 結果頁(CORE_API 1.14.0 handleCallback Response 透傳)
//   - 失敗交易:pending→failed、不觸發 hook

const HASH_KEY = "abcdefghijklmnopqrstuvwxyz123456";
const HASH_IV = "1234567890123456";
const MERCHANT_ID = "MS300000001";
const ORDER_NO = "SKTEST1";

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) =>
    key in settingsStore.values ? settingsStore.values[key] : fallback,
  setSettings: async (entries: Record<string, unknown>) => {
    Object.assign(settingsStore.values, entries);
  },
}));

vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => false }));

// loader:enabled runtime 只含真實 newebpay extension;並在 bus 上掛觀測者,
// 捕捉 payment:succeeded 的觸發(hoisted 陣列)。
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

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

function ctx(providerId: string) {
  return { params: Promise.resolve({ capability: "payment", providerId }) };
}

function post(providerId: string, body: string): Promise<Response> {
  return POST(
    new Request(`https://cms.test/api/callback/payment/${providerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    ctx(providerId),
  );
}

/** 以測試金鑰組出一筆合法的藍新回呼 body(TradeInfo 加密 + TradeSha)。 */
async function callbackBody(payload: unknown): Promise<string> {
  const tradeInfo = await encryptTradeInfo(
    JSON.stringify(payload),
    HASH_KEY,
    HASH_IV,
  );
  const sha = await tradeSha(tradeInfo, HASH_KEY, HASH_IV);
  return new URLSearchParams({
    Status: "SUCCESS",
    MerchantID: MERCHANT_ID,
    Version: "2.0",
    TradeInfo: tradeInfo,
    TradeSha: sha,
  }).toString();
}

function successPayload(orderNo = ORDER_NO) {
  return {
    Status: "SUCCESS",
    Message: "授權成功",
    Result: {
      MerchantOrderNo: orderNo,
      TradeNo: "25071612345678901",
      PaymentType: "CREDIT",
      PayTime: "2026-07-16 12:00:00",
      Amt: 100,
    },
  };
}

async function orderRow(orderNo: string) {
  return d1()
    .prepare(
      "SELECT status, trade_no, payment_type FROM ext_newebpay_orders WHERE order_no = ?",
    )
    .bind(orderNo)
    .first<{ status: string; trade_no: string | null; payment_type: string | null }>();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS ext_newebpay_orders (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM ext_newebpay_orders;");
  await d1()
    .prepare(
      "INSERT INTO ext_newebpay_orders (order_no, amount, description, status, created_at, updated_at) VALUES (?, 100, '測試訂單', 'pending', 1, 1)",
    )
    .bind(ORDER_NO)
    .run();
  settingsStore.values = {
    "ext.newebpay.merchantId": MERCHANT_ID,
    "ext.newebpay.hashKey": HASH_KEY,
    "ext.newebpay.hashIv": HASH_IV,
    "ext.newebpay.env": "test",
    "core.siteUrl": "https://shop.example",
  };
  hookEvents.events = [];
});

describe("callback ingress — 驗簽", () => {
  it("404 on unknown providerId", async () => {
    const res = await post("nonesuch", await callbackBody(successPayload()));
    expect(res.status).toBe(404);
  });

  it("403 on tampered TradeSha", async () => {
    const body = await callbackBody(successPayload());
    const form = new URLSearchParams(body);
    form.set("TradeSha", "0".repeat(64));
    const res = await post("newebpay", form.toString());
    expect(res.status).toBe(403);
    expect((await orderRow(ORDER_NO))?.status).toBe("pending"); // handler 未執行
    expect(hookEvents.events).toHaveLength(0);
  });

  it("403 fail-closed when merchant keys unset", async () => {
    const body = await callbackBody(successPayload());
    settingsStore.values = {}; // 全部清空
    const res = await post("newebpay", body);
    expect(res.status).toBe(403);
  });
});

describe("callback ingress — notify(server-to-server)", () => {
  it("200 {ok:true}; order pending→paid; payment:succeeded fired once", async () => {
    const res = await post("newebpay", await callbackBody(successPayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await orderRow(ORDER_NO);
    expect(row?.status).toBe("paid");
    expect(row?.trade_no).toBe("25071612345678901");
    expect(row?.payment_type).toBe("CREDIT");

    expect(hookEvents.events).toHaveLength(1);
    expect(hookEvents.events[0]).toMatchObject({ providerId: "newebpay" });
  });

  it("idempotent: second notify for a paid order neither rewrites nor re-fires hook", async () => {
    await post("newebpay", await callbackBody(successPayload()));
    const res = await post("newebpay", await callbackBody(successPayload()));
    expect(res.status).toBe(200);
    expect(hookEvents.events).toHaveLength(1);
    expect((await orderRow(ORDER_NO))?.status).toBe("paid");
  });

  it("concurrent notify and return settlements dispatch payment:succeeded exactly once", async () => {
    const body = await callbackBody(successPayload());
    const [notify, returned] = await Promise.all([
      post("newebpay", body),
      post("newebpay-return", body),
    ]);

    expect(notify.status).toBe(200);
    expect(returned.status).toBe(200);
    expect((await orderRow(ORDER_NO))?.status).toBe("paid");
    expect(hookEvents.events).toHaveLength(1);
  });

  it("failed transaction → pending→failed, no hook", async () => {
    const payload = {
      ...successPayload(),
      Status: "TRA10035",
      Message: "付款失敗",
    };
    const res = await post("newebpay", await callbackBody(payload));
    expect(res.status).toBe(200);
    expect((await orderRow(ORDER_NO))?.status).toBe("failed");
    expect(hookEvents.events).toHaveLength(0);
  });

  it("unknown order: verified but no row → 200, nothing written", async () => {
    const res = await post(
      "newebpay",
      await callbackBody(successPayload("SK_NOT_EXIST")),
    );
    expect(res.status).toBe(200);
    expect(hookEvents.events).toHaveLength(0);
  });
});

describe("callback ingress — return(瀏覽器導回,1.14.0 Response 透傳)", () => {
  it("returns text/html result page and still settles the order", async () => {
    const res = await post(
      "newebpay-return",
      await callbackBody(successPayload()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const buf = await res.arrayBuffer(); // 避免 res.text() 對非 text/* 的 Miniflare 警告
    const html = new TextDecoder().decode(buf);
    expect(html).toContain("付款完成");
    expect(html).toContain(ORDER_NO);
    expect(html).toContain("https://shop.example"); // 返回網站連結
    expect((await orderRow(ORDER_NO))?.status).toBe("paid");
    expect(hookEvents.events).toHaveLength(1);
  });

  it("return after notify: HTML page, hook not re-fired", async () => {
    await post("newebpay", await callbackBody(successPayload()));
    const res = await post(
      "newebpay-return",
      await callbackBody(successPayload()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(hookEvents.events).toHaveLength(1);
  });

  it("failed transaction renders the failure page", async () => {
    const payload = { ...successPayload(), Status: "TRA10035" };
    const res = await post("newebpay-return", await callbackBody(payload));
    const buf = await res.arrayBuffer();
    const html = new TextDecoder().decode(buf);
    expect(html).toContain("付款未完成");
    expect((await orderRow(ORDER_NO))?.status).toBe("failed");
  });
});

describe("provider — createCheckout", () => {
  async function makeProvider() {
    const { createPaymentProvider } = await import("@/ext/payment-kit");
    const { createNewebPayAdapter } = await import(
      "../extensions/newebpay/adapter"
    );
    const { db } = await import("@/lib/db");
    const { getSetting } = await import("@/lib/settings");
    // 測試用最小 services:kit 引擎碰 db / hooks,adapter 碰 settings。
    const services = {
      db: db(),
      settings: {
        get: (key: string, fb?: unknown) => getSetting(key, fb),
        set: async () => {},
      },
      hooks: { doAction: async () => {} },
    } as unknown as import("@/ext/services").CoreServices;
    return createPaymentProvider({
      services,
      adapter: createNewebPayAdapter(services),
      providerId: "newebpay",
      table: "ext_newebpay_orders",
      mode: "notify",
    });
  }

  it("not_configured when merchant keys missing", async () => {
    settingsStore.values = { "core.siteUrl": "https://shop.example" };
    const provider = await makeProvider();
    const session = await provider.createCheckout({
      orderNo: "SKNEW1",
      amount: 100,
      description: "x",
    });
    expect(session).toEqual({ ok: false, error: "not_configured" });
  });

  it("builds form-post session with decryptable TradeInfo + matching TradeSha, inserts pending order", async () => {
    const provider = await makeProvider();
    const session = await provider.createCheckout({
      orderNo: "SKNEW2",
      amount: 250,
      description: "藍新測試",
      email: "buyer@example.com",
    });
    expect(session.ok).toBe(true);
    if (!session.ok || session.kind !== "form-post") throw new Error("shape");
    expect(session.gatewayUrl).toBe(
      "https://ccore.newebpay.com/MPG/mpg_gateway",
    );
    expect(session.fields.MerchantID).toBe(MERCHANT_ID);
    expect(session.fields.Version).toBe("2.0");
    expect(
      await tradeSha(session.fields.TradeInfo, HASH_KEY, HASH_IV),
    ).toBe(session.fields.TradeSha);

    const { decryptTradeInfo } = await import("../extensions/newebpay/crypto");
    const plain = await decryptTradeInfo(
      session.fields.TradeInfo,
      HASH_KEY,
      HASH_IV,
    );
    expect(plain).not.toBeNull();
    const params = new URLSearchParams(plain as string);
    expect(params.get("MerchantOrderNo")).toBe("SKNEW2");
    expect(params.get("Amt")).toBe("250");
    expect(params.get("NotifyURL")).toBe(
      "https://shop.example/api/callback/payment/newebpay",
    );
    expect(params.get("ReturnURL")).toBe(
      "https://shop.example/api/callback/payment/newebpay-return",
    );

    expect((await orderRow("SKNEW2"))?.status).toBe("pending");
  });

  it("rejects illegal orderNo / amount / description without touching db", async () => {
    const provider = await makeProvider();
    expect(
      await provider.createCheckout({
        orderNo: "has space",
        amount: 1,
        description: "x",
      }),
    ).toEqual({ ok: false, error: "invalid_order_no" });
    expect(
      await provider.createCheckout({
        orderNo: "SKX",
        amount: 1.5,
        description: "x",
      }),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(
      await provider.createCheckout({
        orderNo: "SKX",
        amount: 1,
        description: "曖".repeat(51),
      }),
    ).toEqual({ ok: false, error: "invalid_description" });
  });
});
