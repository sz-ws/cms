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
/** 1.63.0:套用過 shop 0005 的表(有 transfer_payer),和收款方式自訂回報內容的 provider。 */
const SPEC_TABLE = "ext_shopspec_orders";
const SPEC_PAY_TABLE = "ext_manualspec_orders";
const reportSpec = { ask: "reference" as "reference" | "payerName" | "either" | "both", label: "帳號末五碼", digits: 5 };

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
        if (id === "manualspec") return specProvider;
        if (id === "fakecard") return cardProvider;
        return null;
      },
    },
  } as unknown as CoreServices;
  const specProvider = createManualPaymentProvider({
    services,
    providerId: "manualspec",
    table: SPEC_PAY_TABLE,
    instructions: async () => ({ ok: true, instructions: [{ label: "帳號", value: "123-456" }] }),
    reportSpec: async () => ({ ask: reportSpec.ask, reference: { label: reportSpec.label, digits: reportSpec.digits } }),
  });
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
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${SPEC_TABLE} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, transfer_payer TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${SPEC_PAY_TABLE} (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec(`DELETE FROM ${SHOP_TABLE};`);
  await d1().exec(`DELETE FROM ${PAY_TABLE};`);
  await d1().exec(`DELETE FROM ${SPEC_TABLE};`);
  await d1().exec(`DELETE FROM ${SPEC_PAY_TABLE};`);
  Object.assign(reportSpec, { ask: "reference", label: "帳號末五碼", digits: 5 });
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

  // 這一條釘的是一個曾經**安靜失敗又回報成功**的路徑。上面那個「退回後重報」走的是
  // pending_payment → awaiting_verify 的正常轉移;客人打錯末五碼、在 admin 核帳前
  // 自己重報一次,狀態**還停在 awaiting_verify**,而那條路原本又呼叫了一次剛剛才回
  // false 的 transitionOrder,末五碼整個被丟掉,handler 卻無條件回 ok:true。
  it("仍在 awaiting_verify 時重報 → 末五碼真的被改到,而且不是假的 ok", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;

    await reportHandler(reportReq(orderNo, "11111"), {}, ctx());
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.transferLast5).toBe(
      "11111",
    );

    // 沒有經過退回 —— 訂單此刻仍是 awaiting_verify。
    const again = await reportHandler(reportReq(orderNo, "22222"), {}, ctx());
    expect(again.status).toBe(200);

    const order = await getOrder({ db: db() }, SHOP_TABLE, orderNo);
    expect(order?.status).toBe("awaiting_verify");
    expect(order?.transferLast5).toBe("22222");
  });

  it("狀態不收回報時 → 404,不是假的 ok", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    await reportHandler(reportReq(orderNo), {}, ctx());
    await verifyHandler(verifyReq(true), { orderNo }, ctx("editor")); // → paid

    const late = await reportHandler(reportReq(orderNo, "99999"), {}, ctx());
    expect(late.status).toBe(404);
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.transferLast5).toBe(
      "12345",
    );
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

  // refunded 曾經只存在於規則裡:ORDER_TRANSITIONS 宣告 paid → refunded 合法、pill
  // 顏色也備好了,但三個入口(狀態路由的 enum、agent tool 的 enum、後台按鈕)全都
  // 沒有它,所以那個狀態實際上到不了。這一條釘住「規則宣告的,入口就到得了」。
  it("記帳用的 refunded:paid → refunded 到得了,已完成的單不行", async () => {
    function statusReq(to: string): Request {
      return new Request("https://cms.test/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
    }

    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    await reportHandler(reportReq(orderNo), {}, ctx());
    await verifyHandler(verifyReq(true), { orderNo }, ctx());

    expect((await statusHandler(statusReq("refunded"), { orderNo }, ctx())).status).toBe(
      200,
    );
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.status).toBe("refunded");

    // 出貨完成之後不是退款的合法來源 —— 狀態機仍然是唯一的規則。
    const other = await checkout();
    const otherNo = other.body.orderNo as string;
    await reportHandler(reportReq(otherNo), {}, ctx());
    await verifyHandler(verifyReq(true), { orderNo: otherNo }, ctx());
    await statusHandler(statusReq("shipped"), { orderNo: otherNo }, ctx());
    await statusHandler(statusReq("completed"), { orderNo: otherNo }, ctx());
    expect(
      (await statusHandler(statusReq("refunded"), { orderNo: otherNo }, ctx())).status,
    ).toBe(409);
  });
});

describe("匯款回報照收款方式的 reportSpec(1.63.0)", () => {
  const specCheckout = createCommerceCheckoutHandler({ table: SPEC_TABLE, resolveProvider: async () => "manualspec" });
  const specReport = createTransferReportHandler({ table: SPEC_TABLE, resolveTransferProvider: async () => "manualspec" });
  const specVerify = createTransferVerifyHandler({ table: SPEC_TABLE, resolveTransferProvider: async () => "manualspec" });
  const report = (body: Record<string, unknown>) =>
    new Request("https://cms.test/api/ext/shop/transfer-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify(body),
    });
  async function place(): Promise<string> {
    const res = await specCheckout(post(VALID_BODY), {}, ctx());
    return ((await res.json()) as { orderNo: string }).orderNo;
  }

  it("預設(帳號末五碼):reference 與舊的 last5 都收;還沒有 transfer_payer 欄的表照樣寫得進去", async () => {
    const { body } = await checkout();
    const orderNo = body.orderNo as string;
    expect((await reportHandler(report({ orderNo, reference: "12345" }), {}, ctx())).status).toBe(200);
    expect(await getOrder({ db: db() }, SHOP_TABLE, orderNo)).toMatchObject({ status: "awaiting_verify", transferReference: "12345", transferLast5: "12345", transferPayer: null });
    // Deprecated until 2.0: the old body.
    expect((await reportHandler(report({ orderNo, last5: "54321" }), {}, ctx())).status).toBe(200);
    expect((await getOrder({ db: db() }, SHOP_TABLE, orderNo))?.transferReference).toBe("54321");
    const bad = await reportHandler(report({ orderNo, reference: "1234" }), {}, ctx());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "invalid_input", message: "帳號末五碼要填 5 位數字。" });
  });

  it("自訂名稱與位數:照收款方式檢查,核帳紀錄寫它的名稱", async () => {
    Object.assign(reportSpec, { label: "轉帳後六碼", digits: 6 });
    const orderNo = await place();
    const short = await specReport(report({ orderNo, reference: "12345" }), {}, ctx());
    expect(await short.json()).toMatchObject({ error: "invalid_input", message: "轉帳後六碼要填 6 位數字。" });
    expect((await specReport(report({ orderNo, reference: "123456" }), {}, ctx())).status).toBe(200);
    const verified = await specVerify(
      new Request("https://cms.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: true }) }),
      { orderNo },
      ctx("editor"),
    );
    expect(verified.status).toBe(200);
    expect((await getOrder({ db: db() }, SPEC_TABLE, orderNo))?.note).toContain("轉帳後六碼 123456");
  });

  it("匯款人姓名:存在 transfer_payer;擇一時一次回報取代上一次", async () => {
    reportSpec.ask = "payerName";
    const orderNo = await place();
    expect((await specReport(report({ orderNo, reference: "12345" }), {}, ctx())).status).toBe(400);
    expect((await specReport(report({ orderNo, payerName: " 王小明 ", reference: "12345" }), {}, ctx())).status).toBe(200);
    expect(await getOrder({ db: db() }, SPEC_TABLE, orderNo)).toMatchObject({ transferPayer: "王小明", transferReference: null });

    reportSpec.ask = "either";
    expect((await specReport(report({ orderNo, reference: "12345" }), {}, ctx())).status).toBe(200);
    expect(await getOrder({ db: db() }, SPEC_TABLE, orderNo)).toMatchObject({ status: "awaiting_verify", transferPayer: null, transferReference: "12345" });
  });
});
