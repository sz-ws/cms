import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// commerce-kit 結帳協調器 + 匯款全流程的 binding-backed 測試。
// 真 D1、真 HookBus、真 manual provider(payment-kit);content/card provider 與
// providers registry 以 fake 注入(單元邊界:kit 引擎本身)。
// 覆蓋:伺服器計價(永不信 client)、published-only、付款方式解析、session 透傳、
// 訂單建立順序,以及 匯款回報 → 核帳核可/退回 → hook 翻單 的完整鏈。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const rateLimit = vi.hoisted(() => ({ limited: false }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => rateLimit.limited,
}));

import { db } from "../src/lib/db";
import { HookBus } from "../src/ext/hooks";
import { createManualPaymentProvider } from "../src/ext/payment-kit/manual";
import { createCommerceCheckoutHandler } from "../src/ext/commerce-kit/checkout";
import {
  createOrderStatusHandler,
  createTransferReportHandler,
  createTransferVerifyHandler,
} from "../src/ext/commerce-kit/transfer";
import { getOrder, markOrderPaid } from "../src/ext/commerce-kit/orders";
import type { ApiCtx } from "../src/ext/types";
import type { CheckoutRequest, ContentEntry } from "../src/ext/capabilities";
import type { CoreServices } from "../src/ext/services";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const SHOP_TABLE = "ext_shopflow_orders";
const PAY_TABLE = "ext_manualflow_orders";

// ---- fakes ----

const products = new Map<string, ContentEntry>();
function product(id: string, over: Partial<ContentEntry["data"]> = {}, status: ContentEntry["status"] = "published"): void {
  products.set(id, {
    id,
    type: "catalog.product",
    slug: id,
    status,
    data: { name: `商品${id}`, price: 100, ...over },
    createdAt: 1,
    updatedAt: 1,
  });
}

const cardCalls: CheckoutRequest[] = [];
const cardProvider = {
  createCheckout: async (req: CheckoutRequest) => {
    cardCalls.push(req);
    return {
      ok: true as const,
      kind: "form-post" as const,
      gatewayUrl: "https://gw.example/pay",
      fields: { OrderNo: req.orderNo },
    };
  },
};

function makeServices(): CoreServices {
  const hooks = new HookBus();
  // 鏡射 extensions/shop 的 hook 綁定:訂單翻 paid 的唯一路徑。
  hooks.register("shop", "payment:succeeded", (payload: unknown) =>
    markOrderPaid({ db: db() }, SHOP_TABLE, payload),
  );
  const services = {
    db: db(),
    hooks,
    providers: {
      get: (cap: string) => {
        if (cap !== "content") throw new Error(`no provider for ${cap}`);
        return {
          get: async (type: string, id: string) =>
            type === "catalog.product" ? (products.get(id) ?? null) : null,
        };
      },
      getById: (cap: string, id: string) => {
        if (cap !== "payment") return null;
        if (id === "manualtest") return manualProvider;
        if (id === "fakecard") return cardProvider;
        return null;
      },
    },
  } as unknown as CoreServices;
  const manualProvider = createManualPaymentProvider({
    services,
    providerId: "manualtest",
    table: PAY_TABLE,
    instructions: async () => ({
      ok: true,
      instructions: [{ label: "帳號", value: "123-456" }],
    }),
  });
  return services;
}

let services: CoreServices;

function ctx(role: "editor" | "anonymous" = "anonymous"): ApiCtx {
  return {
    user: {
      id: role,
      email: `${role}@test`,
      name: role,
      role: "editor",
      avatarKey: null,
    },
    services,
  } as ApiCtx;
}

const checkoutHandler = createCommerceCheckoutHandler({
  table: SHOP_TABLE,
  resolveProvider: async (_c, method) =>
    method === "card" ? "fakecard" : "manualtest",
});
const reportHandler = createTransferReportHandler({ table: SHOP_TABLE });
const verifyHandler = createTransferVerifyHandler({
  table: SHOP_TABLE,
  resolveTransferProvider: async () => "manualtest",
});
const statusHandler = createOrderStatusHandler({ table: SHOP_TABLE });

function post(body: unknown): Request {
  return new Request("https://cms.test/api/ext/shop/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  items: [{ productId: "p1", qty: 2 }],
  name: "王小明",
  email: "ming@example.com",
  method: "transfer" as const,
};

async function checkout(over: Partial<typeof VALID_BODY> & Record<string, unknown> = {}) {
  const res = await checkoutHandler(post({ ...VALID_BODY, ...over }), {}, ctx());
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${SHOP_TABLE} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${PAY_TABLE} (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec(`DELETE FROM ${SHOP_TABLE};`);
  await d1().exec(`DELETE FROM ${PAY_TABLE};`);
  products.clear();
  cardCalls.length = 0;
  rateLimit.limited = false;
  services = makeServices();
  product("p1", { price: 300 });
  product("p2", { price: 50 });
});

describe("checkout(伺服器計價)", () => {
  it("匯款 happy path:manual session + 訂單 pending_payment + 金額由 catalog 算", async () => {
    const { res, body } = await checkout();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.amounts).toEqual({
      subtotal: 600,
      discount: 0,
      shipping: 0,
      total: 600,
    });
    expect((body.session as { kind: string }).kind).toBe("manual");

    const order = await getOrder({ db: db() }, SHOP_TABLE, body.orderNo as string);
    expect(order).toMatchObject({
      status: "pending_payment",
      paymentProvider: "manualtest",
      lines: [{ productId: "p1", name: "商品p1", unitPrice: 300, qty: 2 }],
    });
    // 付款列同號存在(provider 寫入)
    const pay = await d1()
      .prepare(`SELECT status, amount FROM ${PAY_TABLE} WHERE order_no = ?`)
      .bind(body.orderNo)
      .first<{ status: string; amount: number }>();
    expect(pay).toEqual({ status: "pending", amount: 600 });
  });

  it("刷卡:session 透傳 form-post,amount 用伺服器價(client 無從給價)", async () => {
    const { res, body } = await checkout({
      items: [
        { productId: "p1", qty: 1 },
        { productId: "p2", qty: 3 },
        { productId: "p1", qty: 1 }, // 重複列 → 合併
      ],
      method: "card",
    });
    expect(res.status).toBe(200);
    expect((body.session as { kind: string }).kind).toBe("form-post");
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0].amount).toBe(300 * 2 + 50 * 3);
    const order = await getOrder({ db: db() }, SHOP_TABLE, body.orderNo as string);
    expect(order?.lines).toEqual([
      { productId: "p1", name: "商品p1", unitPrice: 300, qty: 2 },
      { productId: "p2", name: "商品p2", unitPrice: 50, qty: 3 },
    ]);
  });

  it("未知 / 未發佈 / 無價格商品 → 422 且不建單", async () => {
    const ghost = await checkout({ items: [{ productId: "ghost", qty: 1 }] });
    expect(ghost.res.status).toBe(422);
    expect(ghost.body.error).toBe("unknown_product");

    product("draft", { price: 100 }, "draft");
    const draft = await checkout({ items: [{ productId: "draft", qty: 1 }] });
    expect(draft.res.status).toBe(422);
    expect(draft.body.error).toBe("unknown_product");

    product("free", { price: "not-a-number" as unknown as number });
    const bad = await checkout({ items: [{ productId: "free", qty: 1 }] });
    expect(bad.res.status).toBe(422);
    expect(bad.body.error).toBe("unpriced_product");

    const count = await d1()
      .prepare(`SELECT COUNT(*) AS n FROM ${SHOP_TABLE}`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("驗證與防護:壞 body 400、rate limit 429、未啟用方式 422、provider 缺 503", async () => {
    const invalid = await checkoutHandler(post({ items: [] }), {}, ctx());
    expect(invalid.status).toBe(400);

    rateLimit.limited = true;
    const limited = await checkout();
    expect(limited.res.status).toBe(429);
    rateLimit.limited = false;

    const none = createCommerceCheckoutHandler({
      table: SHOP_TABLE,
      resolveProvider: async () => "",
    });
    const disabled = await none(post(VALID_BODY), {}, ctx());
    expect(disabled.status).toBe(422);
    expect(((await disabled.json()) as { error: string }).error).toBe(
      "method_not_enabled",
    );

    const missing = createCommerceCheckoutHandler({
      table: SHOP_TABLE,
      resolveProvider: async () => "no-such-provider",
    });
    const unavailable = await missing(post(VALID_BODY), {}, ctx());
    expect(unavailable.status).toBe(503);
  });
});

describe("匯款全流程:回報 → 核帳 → hook 翻單", () => {
  function reportReq(orderNo: string, last5 = "12345"): Request {
    return new Request("https://cms.test/api/ext/shop/transfer-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ orderNo, last5 }),
    });
  }
  function verifyReq(approve: boolean): Request {
    return new Request("https://cms.test/api/ext/shop/orders/x/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve }),
    });
  }

  it("核可:訂單 paid(經 payment:succeeded)+ 付款列 paid + 核帳紀錄", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;

    const report = await reportHandler(reportReq(orderNo), {}, ctx());
    expect(report.status).toBe(200);
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.status).toBe(
      "awaiting_verify",
    );

    const verify = await verifyHandler(verifyReq(true), { orderNo }, ctx("editor"));
    expect(verify.status).toBe(200);
    const order = await getOrder({ db: db() }, SHOP_TABLE, orderNo);
    expect(order?.status).toBe("paid");
    expect(order?.note).toContain("核可 by editor@test");
    expect(order?.note).toContain("12345");
    const pay = await d1()
      .prepare(`SELECT status FROM ${PAY_TABLE} WHERE order_no = ?`)
      .bind(orderNo)
      .first<{ status: string }>();
    expect(pay?.status).toBe("paid");
  });

  it("退回:訂單回 pending_payment、付款列 failed;可重報再核可", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    await reportHandler(reportReq(orderNo), {}, ctx());

    const reject = await verifyHandler(verifyReq(false), { orderNo }, ctx("editor"));
    expect(reject.status).toBe(200);
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.status).toBe(
      "pending_payment",
    );
    const pay = await d1()
      .prepare(`SELECT status FROM ${PAY_TABLE} WHERE order_no = ?`)
      .bind(orderNo)
      .first<{ status: string }>();
    expect(pay?.status).toBe("failed");

    // 重報(更新末五碼)→ 再核可 → paid
    await reportHandler(reportReq(orderNo, "54321"), {}, ctx());
    const order = await getOrder({ db: db() }, SHOP_TABLE, orderNo);
    expect(order?.status).toBe("awaiting_verify");
    expect(order?.transferLast5).toBe("54321");
    await verifyHandler(verifyReq(true), { orderNo }, ctx("editor"));
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.status).toBe("paid");
  });

  it("後台直接切換:未回報(pending_payment)也可核可入帳;退回僅限已回報", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;

    // 沒有回報就沒有東西可「退回」
    const reject = await verifyHandler(verifyReq(false), { orderNo }, ctx());
    expect(reject.status).toBe(409);

    // 台灣無 open banking:admin 對到帳即可直接核可,不以客人回報為前提
    const direct = await verifyHandler(verifyReq(true), { orderNo }, ctx("editor"));
    expect(direct.status).toBe(200);
    const order = await getOrder({ db: db() }, SHOP_TABLE, orderNo);
    expect(order?.status).toBe("paid");
    expect(order?.note).toContain("未經回報");
  });

  it("守門:已付款不可再核帳(409)、查無單 404、付款列缺失 500 不翻單", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    await reportHandler(reportReq(orderNo), {}, ctx());
    await verifyHandler(verifyReq(true), { orderNo }, ctx());
    const again = await verifyHandler(verifyReq(true), { orderNo }, ctx());
    expect(again.status).toBe(409);

    const missing = await verifyHandler(verifyReq(true), { orderNo: "GHOST" }, ctx());
    expect(missing.status).toBe(404);

    // 付款列被清 → 沒有錢的紀錄就不能 paid
    const other = await checkout();
    const otherNo = other.body.orderNo as string;
    await reportHandler(reportReq(otherNo), {}, ctx());
    await d1().prepare(`DELETE FROM ${PAY_TABLE} WHERE order_no = ?`).bind(otherNo).run();
    const broken = await verifyHandler(verifyReq(true), { orderNo: otherNo }, ctx());
    expect(broken.status).toBe(500);
    expect((await getOrder({ db: db() }, SHOP_TABLE, otherNo))?.status).toBe(
      "awaiting_verify",
    );
  });

  it("回報守門:格式錯 400、查無單 404", async () => {
    const bad = await reportHandler(reportReq("SO1", "abc"), {}, ctx());
    expect(bad.status).toBe(400);
    const ghost = await reportHandler(reportReq("GHOSTNO"), {}, ctx());
    expect(ghost.status).toBe(404);
  });

  it("出貨動線:paid → shipped → completed;pending 可取消、paid 不可", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    await reportHandler(reportReq(orderNo), {}, ctx());
    await verifyHandler(verifyReq(true), { orderNo }, ctx());

    function statusReq(to: string): Request {
      return new Request("https://cms.test/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
    }
    const cancelPaid = await statusHandler(statusReq("cancelled"), { orderNo }, ctx());
    expect(cancelPaid.status).toBe(409); // 已收款不可取消(退款另議)

    expect((await statusHandler(statusReq("shipped"), { orderNo }, ctx())).status).toBe(200);
    expect((await statusHandler(statusReq("completed"), { orderNo }, ctx())).status).toBe(200);
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.status).toBe("completed");

    const other = await checkout();
    const cancel = await statusHandler(
      statusReq("cancelled"),
      { orderNo: other.body.orderNo as string },
      ctx(),
    );
    expect(cancel.status).toBe(200);
  });
});
