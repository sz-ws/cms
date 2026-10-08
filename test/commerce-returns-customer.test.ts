import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 客人自己申請退貨(commerce-kit):公開路由 POST returns/customer。真 D1;誰是這張訂單的客人由
// 訂單歸誰決定 —— core 自己的訂單看下單的 Email,訂單管理插件的訂單問它的 customerOrder()(這裡是替身)。
// 測的是規則:誰能申請、什麼時候、幾件、金額誰決定,以及不是自己的訂單和不存在的訂單看起來一樣。
//
// 退貨表用商店 0004_returns 的 migration 換成本檔自己的前綴(DB 跨測試檔共用)。

vi.mock("@/lib/cf", () => ({ getEnv: () => env, getDB: () => (env as { DB: unknown }).DB }));

const limits = vi.hoisted(() => ({ hits: [] as [string, string][], refunds: [] as [string, string][], blocked: new Set<string>() }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async (id: string, opts: { namespace: string }) => {
    limits.hits.push([id, opts.namespace]);
    return limits.blocked.has(opts.namespace);
  },
  refundRateLimit: async (id: string, opts: { namespace: string }) => {
    limits.refunds.push([id, opts.namespace]);
  },
}));

const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; role: "guest" | "admin" } }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => auth.user, isFullAdmin: (u: { role: string } | null) => u?.role === "admin" }));

type Answer = { ok: true; memberId: string | null; shippedAt: number | null } | { ok: false };
const manager = vi.hoisted(() => ({
  customerOrder: undefined as undefined | ReturnType<typeof vi.fn>,
  transition: async () => true,
  checkout: async () => Response.json({ ok: true }),
}));
const world = vi.hoisted(() => ({ enabled: ["mgr"] as string[] }));

vi.mock("@/ext/loader", () => {
  const ext = { id: "mgr", name: "訂單管理", version: "1.0.0", coreApi: "^1.63.0", provides: [{ capability: "commerce:orders", id: "ext_rcust_orders", create: () => manager }] };
  return {
    getExtRuntime: async () => ({
      all: [ext],
      enabled: world.enabled.includes("mgr") ? [ext] : [],
      byId: (id: string) => (id === "mgr" && world.enabled.includes("mgr") ? ext : undefined),
    }),
  };
});
vi.mock("@/ext/services", () => ({
  buildProviderRegistry: () => ({
    getById: (capability: string, id: string) => (capability === "commerce:orders" && id === "ext_rcust_orders" && world.enabled.includes("mgr") ? manager : null),
  }),
}));

import { db } from "../src/lib/db";
import {
  CUSTOMER_RETURN_MAX_DAYS,
  ReturnError,
  askedByCustomer,
  customerActorId,
  customerReturnDays,
  customerReturnDeadline,
  suggestedRefund,
  type CustomerReturnView,
} from "../src/ext/commerce-kit/returns";
import { createReturnsEngine } from "../src/ext/commerce-kit/returns-engine";
import { CUSTOMER_RETURN_LIMITS, createCustomerReturnRoutes } from "../src/ext/commerce-kit/returns-customer";
import { ORDER_EMAIL_PROOF_LIMITS } from "../src/ext/commerce-kit/customer-order";
import { shopMigrations } from "../extensions/shop/schema";
import type { ApiCtx } from "../src/ext/types";
import type { CoreServices } from "../src/ext/services";

const d1 = () => (env as { DB: D1Database }).DB;
const ORDERS = "ext_rcust_orders";
const PREFIX = "ext_rcust_return";
const CONFIG = { ordersTable: ORDERS, prefix: PREFIX };
const DAYS_KEY = "ext.shop.customerReturnDays";
const DAY = 86_400_000;
const staff = { id: "u-admin", name: "店長" };

const settings: Record<string, unknown> = {};
function ctx(): ApiCtx {
  return {
    user: { id: "anonymous", email: "anonymous@public", name: "Anonymous", role: "editor", avatarKey: null },
    services: {
      db: db(),
      settings: { get: async (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback), set: async () => {} },
      providers: { list: () => [], getById: () => null },
    } as unknown as CoreServices,
  } as ApiCtx;
}

const route = (config = CONFIG) => createCustomerReturnRoutes(config, { daysKey: DAYS_KEY })[0];
async function call(body: unknown, config = CONFIG): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request("https://cms.test/api/ext/shop/returns/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await route(config).handler(req, {}, ctx());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const view = (reply: { body: Record<string, unknown> }) => reply.body.view as CustomerReturnView;

const LINES = [
  { productId: "p1", name: "商品一", unitPrice: 300, qty: 2 },
  { productId: "p2", name: "商品二", unitPrice: 150, qty: 1 },
];
const EMAIL = "ming@example.com";

/** 一張訂單:商品 750、折扣 75、運費 100 → 775。shippedDaysAgo 是訂單最後一次異動(core 自己的訂單 = 出貨)離現在幾天。 */
async function seedOrder(orderNo: string, opts: { status?: string; managedBy?: string; shippedDaysAgo?: number } = {}) {
  const at = Date.now() - (opts.shippedDaysAgo ?? 2) * DAY;
  await d1()
    .prepare(
      `INSERT INTO ${ORDERS} (order_no, status, lines, subtotal, discount, shipping, total, payment_provider, customer_name, customer_email, customer_phone, created_at, updated_at, managed_by)
       VALUES (?, ?, ?, 750, 75, 100, 775, 'banktransfer', '王小明', ?, '0912-345-678', ?, ?, ?)`,
    )
    .bind(orderNo, opts.status ?? "shipped", JSON.stringify(LINES), EMAIL, at - DAY, at, opts.managedBy ?? null)
    .run();
  return at;
}
const rows = async (orderNo: string) =>
  (await d1().prepare(`SELECT return_no, status, lines, requested_amount, created_by, customer_name, note FROM ${PREFIX}_requests WHERE order_no = ? ORDER BY created_at, return_no`).bind(orderNo).all<{ return_no: string; status: string; lines: string; requested_amount: number; created_by: string; customer_name: string; note: string | null }>()).results;
const ask = (orderNo: string, lines: { productId: string; qty: number }[], extra: Record<string, unknown> = { email: EMAIL }) =>
  call({ action: "request", orderNo, lines, reason: "defective", ...extra });

/** 兩筆退貨的建立時間錯開(列表照建立時間排)。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function run(statements: string) {
  for (const sql of statements.split(";").map((s) => s.trim()).filter(Boolean)) await d1().prepare(sql).run();
}

beforeAll(async () => {
  await run(shopMigrations.find((m) => m.id === "0004_returns")!.sql.replaceAll("ext_shop_return", PREFIX));
  await run(
    `CREATE TABLE IF NOT EXISTS ${ORDERS} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL, lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, managed_by TEXT)`,
  );
});

beforeEach(async () => {
  await run([`DELETE FROM ${ORDERS}`, `DELETE FROM ${PREFIX}_requests`, `DELETE FROM ${PREFIX}_events`, `DELETE FROM ${PREFIX}_operations`].join(";"));
  for (const key of Object.keys(settings)) delete settings[key];
  settings[DAYS_KEY] = 14;
  limits.hits = [];
  limits.refunds = [];
  limits.blocked = new Set();
  auth.user = null;
  world.enabled = ["mgr"];
  manager.customerOrder = undefined;
});

describe("設定:客人可以申請退貨的天數", () => {
  it("整數天;不是數字、負數當 0(不開放),小數捨去,最多一年", () => {
    expect(customerReturnDays(7)).toBe(7);
    expect(customerReturnDays(0)).toBe(0);
    expect(customerReturnDays(2.9)).toBe(2);
    for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY, "7", null, undefined, true, {}]) expect(customerReturnDays(bad), String(bad)).toBe(0);
    expect(customerReturnDays(9999)).toBe(CUSTOMER_RETURN_MAX_DAYS);
  });

  it("期限 = 出貨時間 + 天數;不開放或不知道什麼時候出貨就沒有期限", () => {
    expect(customerReturnDeadline(7, 1_000)).toBe(1_000 + 7 * DAY);
    expect(customerReturnDeadline(0, 1_000)).toBeNull();
    expect(customerReturnDeadline(7, null)).toBeNull();
  });

  it("客人申請的退貨,建立者不是任何後台人員的 id", () => {
    expect(customerActorId(null)).toBe("customer");
    expect(customerActorId("u-9")).toBe("customer:u-9");
    // 不像 id 的東西(空白、太長)不寫進去。
    expect(customerActorId("a b")).toBe("customer");
    expect(customerActorId("x".repeat(200))).toBe("customer");
    expect(askedByCustomer({ createdBy: "customer" })).toBe(true);
    expect(askedByCustomer({ createdBy: "customer:u-9" })).toBe(true);
    expect(askedByCustomer({ createdBy: "u-admin" })).toBe(false);
    expect(askedByCustomer({ createdBy: "customerservice" })).toBe(false);
  });
});

describe("訪客:訂單編號 + 下單 Email(商店自己的訂單)", () => {
  it("看得到能退什麼與期限;申請後是申請中、標成客人申請,金額是後台「新增退貨」的預設", async () => {
    const shippedAt = await seedOrder("SOG1");
    const before = await call({ action: "status", orderNo: "SOG1", email: EMAIL });
    expect(before.status).toBe(200);
    expect(view(before)).toEqual({
      open: true,
      deadline: shippedAt + 14 * DAY,
      lines: [
        { productId: "p1", name: "商品一", returnable: 2 },
        { productId: "p2", name: "商品二", returnable: 1 },
      ],
      returns: [],
    });

    const asked = await ask("SOG1", [{ productId: "p1", qty: 1 }], { email: " Ming@Example.com ", note: " 外盒破損 " });
    expect(asked.status).toBe(200);
    const [row] = await rows("SOG1");
    expect(row).toMatchObject({ status: "requested", created_by: "customer", customer_name: "王小明", note: "外盒破損" });
    expect(JSON.parse(row.lines)).toEqual([{ productId: "p1", name: "商品一", unitPrice: 300, qty: 1, restocked: 0 }]);
    // 一件 300、訂單九折 → 270(不含運費),和後台建立時預設帶的一樣。
    const expected = suggestedRefund({ subtotal: 750, discount: 75, total: 775, refunded: 0 }, [{ unitPrice: 300, qty: 1 }]);
    expect(expected).toBe(270);
    expect(row.requested_amount).toBe(expected);
    expect(asked.body.returnNo).toBe(row.return_no);
    expect(view(asked).returns).toEqual([{ returnNo: row.return_no, status: "requested", lines: [{ name: "商品一", qty: 1 }], createdAt: expect.any(Number) }]);
    expect(view(asked).lines).toEqual([
      { productId: "p1", name: "商品一", returnable: 1 },
      { productId: "p2", name: "商品二", returnable: 1 },
    ]);

    // 處理紀錄上的人是訂單上的客人;後台的退貨列表與明細照常讀得到。
    const engine = createReturnsEngine(d1(), CONFIG);
    expect(await engine.events(row.return_no)).toMatchObject([{ action: "created", actorId: "customer", actorName: "王小明", note: "外盒破損" }]);
    const [listed] = await engine.list({ status: "requested" });
    expect(listed.returnNo).toBe(row.return_no);
    expect(askedByCustomer(listed)).toBe(true);
  });

  it("商店自己的訂單不看登入的人:帳號的 Email 和下單的一樣也不算(不一定驗證過),要帶下單的 Email", async () => {
    await seedOrder("SOG2");
    auth.user = { id: "u-7", email: EMAIL, name: "小明", role: "guest" };
    expect(await ask("SOG2", [{ productId: "p2", qty: 1 }], {})).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect((await ask("SOG2", [{ productId: "p2", qty: 1 }])).status).toBe(200);
    // 訂單上沒有記會員:紀錄上不寫是哪個帳號。
    expect((await rows("SOG2"))[0].created_by).toBe("customer");
  });

  it("客人看不到金額、店家的說明與電話", async () => {
    await seedOrder("SOG3");
    await createReturnsEngine(d1(), CONFIG).create(staff, { orderNo: "SOG3", lines: [{ productId: "p2", qty: 1 }], reason: "other", requestedAmount: 150, note: "客人很兇" });
    const reply = await call({ action: "status", orderNo: "SOG3", email: EMAIL });
    expect(Object.keys(view(reply)).sort()).toEqual(["deadline", "lines", "open", "returns"]);
    expect(Object.keys(view(reply).returns[0]).sort()).toEqual(["createdAt", "lines", "returnNo", "status"]);
    expect(JSON.stringify(reply.body)).not.toMatch(/客人很兇|0912-345|requestedAmount|unitPrice|note/);
  });
});

describe("會員:訂單管理插件說這個人是不是這張訂單的客人", () => {
  it("是:申請成立,期限從它說的出貨時間算;問它的時候帶著訂單編號,沒有 Email", async () => {
    await seedOrder("SMM1", { managedBy: "mgr", status: "completed", shippedDaysAgo: 30 });
    const shippedAt = Date.now() - 3 * DAY;
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: "u-9", shippedAt }));
    const before = await call({ action: "status", orderNo: "SMM1" });
    expect(view(before)).toMatchObject({ open: true, deadline: shippedAt + 14 * DAY });
    expect(manager.customerOrder).toHaveBeenCalledWith({ orderNo: "SMM1" }, expect.any(Request), expect.anything());

    expect((await ask("SMM1", [{ productId: "p1", qty: 2 }], {})).status).toBe(200);
    expect(await rows("SMM1")).toMatchObject([{ status: "requested", created_by: "customer:u-9" }]);
  });

  it("訪客帶的 Email 交給它(它用自己的查單規則)", async () => {
    await seedOrder("SMM2", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: null, shippedAt: Date.now() - DAY }));
    expect((await ask("SMM2", [{ productId: "p1", qty: 1 }])).status).toBe(200);
    expect(manager.customerOrder).toHaveBeenCalledWith({ orderNo: "SMM2", email: EMAIL }, expect.any(Request), expect.anything());
    expect((await rows("SMM2"))[0].created_by).toBe("customer");
  });

  it("它不知道什麼時候出貨:不開放", async () => {
    await seedOrder("SMM3", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: "u-9", shippedAt: null }));
    expect(view(await call({ action: "status", orderNo: "SMM3" }))).toMatchObject({ open: false, blocked: "closed", deadline: null });
    expect(await ask("SMM3", [{ productId: "p1", qty: 1 }], {})).toEqual({ status: 409, body: { ok: false, error: "closed" } });
    expect(await rows("SMM3")).toEqual([]);
  });
});

describe("不是自己的訂單,和不存在的訂單看起來一樣", () => {
  const NOT_FOUND = { status: 404, body: { ok: false, error: "not_found" } };

  it("Email 不對、沒帶 Email 也沒登入、登入的是別人、訂單不存在:同一個回應,什麼都沒建立", async () => {
    await seedOrder("SOX1");
    for (const action of ["status", "request"] as const) {
      const body = action === "request" ? { lines: [{ productId: "p1", qty: 1 }], reason: "other" } : {};
      expect(await call({ action, orderNo: "SOX1", email: "other@example.com", ...body }), `${action} wrong email`).toEqual(NOT_FOUND);
      expect(await call({ action, orderNo: "SOX1", ...body }), `${action} anonymous`).toEqual(NOT_FOUND);
      expect(await call({ action, orderNo: "NOSUCH1", email: EMAIL, ...body }), `${action} no such order`).toEqual(NOT_FOUND);
      auth.user = { id: "u-2", email: "other@example.com", name: "別人", role: "guest" };
      expect(await call({ action, orderNo: "SOX1", ...body }), `${action} someone else`).toEqual(NOT_FOUND);
      auth.user = null;
    }
    expect(await rows("SOX1")).toEqual([]);
  });

  it("後台人員登入也不算這張訂單的客人(店家代建走退貨管理)", async () => {
    await seedOrder("SOX2");
    auth.user = { id: "u-admin", email: "boss@example.com", name: "店長", role: "admin" };
    expect(await ask("SOX2", [{ productId: "p1", qty: 1 }], {})).toEqual(NOT_FOUND);
  });

  it("訂單管理插件的訂單:它說不是、它沒有 customerOrder()、它停用了,都是同一個回應", async () => {
    await seedOrder("SMX1", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: false }));
    expect(await ask("SMX1", [{ productId: "p1", qty: 1 }])).toEqual(NOT_FOUND);
    manager.customerOrder = undefined;
    // 帶對了下單的 Email 也不行:這張訂單歸插件,core 不自己認人。
    expect(await ask("SMX1", [{ productId: "p1", qty: 1 }])).toEqual(NOT_FOUND);
    world.enabled = [];
    expect(await ask("SMX1", [{ productId: "p1", qty: 1 }])).toEqual(NOT_FOUND);
    expect(await call({ action: "status", orderNo: "SMX1", email: EMAIL })).toEqual(NOT_FOUND);
    expect(await rows("SMX1")).toEqual([]);
  });

  it("插件的回答不像樣(少了欄位、丟了別的東西):當作不是", async () => {
    await seedOrder("SMX2", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async () => ({ ok: true }));
    expect(await ask("SMX2", [{ productId: "p1", qty: 1 }])).toEqual(NOT_FOUND);
    manager.customerOrder = vi.fn(async () => null);
    expect(await ask("SMX2", [{ productId: "p1", qty: 1 }])).toEqual(NOT_FOUND);
  });
});

describe("什麼時候可以申請", () => {
  it("設定是 0(預設):不開放 —— 看不到能退什麼,申請不收", async () => {
    await seedOrder("SOW1");
    delete settings[DAYS_KEY];
    expect(view(await call({ action: "status", orderNo: "SOW1", email: EMAIL }))).toEqual({ open: false, blocked: "closed", deadline: null, lines: [], returns: [] });
    expect(await ask("SOW1", [{ productId: "p1", qty: 1 }])).toEqual({ status: 409, body: { ok: false, error: "closed" } });
    settings[DAYS_KEY] = -5;
    expect(await ask("SOW1", [{ productId: "p1", qty: 1 }])).toEqual({ status: 409, body: { ok: false, error: "closed" } });
    expect(await rows("SOW1")).toEqual([]);
  });

  it("設定是 0:對誰都是同一個回答,不認人、不查訂單,也不動用照訂單編號的額度(沒開放的店多不出任何東西)", async () => {
    await seedOrder("SOW0");
    await seedOrder("SMW0", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: "u-9", shippedAt: Date.now() }));
    // 店家代建過退貨:沒開放時客人的訂單頁照樣沒有這一區。
    await createReturnsEngine(d1(), CONFIG).create(staff, { orderNo: "SOW0", lines: [{ productId: "p2", qty: 1 }], reason: "other", requestedAmount: 150 });
    settings[DAYS_KEY] = 0;
    const closed = { status: 200, body: { ok: true, view: { open: false, blocked: "closed", deadline: null, lines: [], returns: [] } } };
    const refused = { status: 409, body: { ok: false, error: "closed" } };
    for (const [orderNo, email] of [["SOW0", EMAIL], ["SOW0", "other@example.com"], ["NOSUCH0", EMAIL], ["SMW0", undefined]] as const) {
      const who = email ? { email } : {};
      expect(await call({ action: "status", orderNo, ...who }), `${orderNo} ${email}`).toEqual(closed);
      expect(await ask(orderNo, [{ productId: "p1", qty: 1 }], who), `${orderNo} ${email}`).toEqual(refused);
    }
    expect(manager.customerOrder).not.toHaveBeenCalled();
    expect(new Set(limits.hits.map(([, namespace]) => namespace))).toEqual(new Set([CUSTOMER_RETURN_LIMITS.perIp.namespace]));
  });

  it("還沒出貨、已取消的訂單不能申請", async () => {
    for (const [orderNo, status, error] of [["SOW2", "paid", "order_not_returnable"], ["SOW3", "pending_payment", "order_not_returnable"], ["SOW4", "cancelled", "order_closed"], ["SOW5", "refunded", "order_closed"]] as const) {
      await seedOrder(orderNo, { status });
      expect(view(await call({ action: "status", orderNo, email: EMAIL })), orderNo).toMatchObject({ open: false, blocked: "not_returnable", lines: [] });
      expect(await ask(orderNo, [{ productId: "p1", qty: 1 }]), orderNo).toEqual({ status: 409, body: { ok: false, error } });
      expect(await rows(orderNo)).toEqual([]);
    }
  });

  it("出貨後超過天數:不收,畫面拿得到期限是哪一天;店家把天數調大就又收", async () => {
    const shippedAt = await seedOrder("SOW6", { shippedDaysAgo: 15 });
    expect(view(await call({ action: "status", orderNo: "SOW6", email: EMAIL }))).toMatchObject({ open: false, blocked: "window_passed", deadline: shippedAt + 14 * DAY, lines: [] });
    expect(await ask("SOW6", [{ productId: "p1", qty: 1 }])).toEqual({ status: 409, body: { ok: false, error: "window_passed" } });
    expect(await rows("SOW6")).toEqual([]);
    settings[DAYS_KEY] = 16;
    expect((await ask("SOW6", [{ productId: "p1", qty: 1 }])).status).toBe(200);
  });

  it("已完成的訂單在期限內一樣能申請", async () => {
    await seedOrder("SOW7", { status: "completed", shippedDaysAgo: 1 });
    expect((await ask("SOW7", [{ productId: "p1", qty: 1 }])).status).toBe(200);
  });
});

describe("件數", () => {
  it("不能超過訂購件數;已經在退貨裡的(店家建的也算)要扣掉", async () => {
    await seedOrder("SOQ1");
    expect(await ask("SOQ1", [{ productId: "p1", qty: 3 }])).toEqual({ status: 409, body: { ok: false, error: "qty_exceeds" } });
    await createReturnsEngine(d1(), CONFIG).create(staff, { orderNo: "SOQ1", lines: [{ productId: "p1", qty: 1 }], reason: "other", requestedAmount: 0 });
    expect(await ask("SOQ1", [{ productId: "p1", qty: 2 }])).toEqual({ status: 409, body: { ok: false, error: "qty_exceeds" } });
    expect((await ask("SOQ1", [{ productId: "p1", qty: 1 }])).status).toBe(200);
    expect(await rows("SOQ1")).toHaveLength(2);
  });

  it("訂單上沒有的商品、0 件、同一項重複列超過:都不收", async () => {
    await seedOrder("SOQ2");
    expect((await ask("SOQ2", [{ productId: "nope", qty: 1 }])).status).toBe(400);
    expect((await ask("SOQ2", [{ productId: "p1", qty: 0 }])).status).toBe(400);
    expect((await ask("SOQ2", [])).status).toBe(400);
    expect(await ask("SOQ2", [{ productId: "p1", qty: 2 }, { productId: "p1", qty: 1 }])).toEqual({ status: 409, body: { ok: false, error: "qty_exceeds" } });
    expect(await rows("SOQ2")).toEqual([]);
  });

  it("同樣的商品不能再申請第二次;都申請過了就不再開放;店家拒絕後可以重新申請", async () => {
    await seedOrder("SOQ3");
    const first = await ask("SOQ3", [{ productId: "p1", qty: 2 }, { productId: "p2", qty: 1 }]);
    expect(first.status).toBe(200);
    expect(view(first)).toMatchObject({ open: false, blocked: "nothing_left", lines: [] });
    expect(await ask("SOQ3", [{ productId: "p1", qty: 1 }])).toEqual({ status: 409, body: { ok: false, error: "qty_exceeds" } });
    expect(await rows("SOQ3")).toHaveLength(1);

    await createReturnsEngine(d1(), CONFIG).transition(staff, String(first.body.returnNo), { to: "rejected" });
    const after = await call({ action: "status", orderNo: "SOQ3", email: EMAIL });
    expect(view(after)).toMatchObject({ open: true, returns: [{ status: "rejected" }] });
    expect((await ask("SOQ3", [{ productId: "p1", qty: 1 }])).status).toBe(200);
  });
});

describe("金額不由客人決定", () => {
  it("帶了金額(或任何不認得的欄位)整個請求不收", async () => {
    await seedOrder("SOA1");
    for (const extra of [{ requestedAmount: 99999 }, { requestedAmount: 0 }, { refund: { amount: 775, method: "cash" } }, { status: "refunded" }, { createdBy: "u-admin" }]) {
      expect(await ask("SOA1", [{ productId: "p1", qty: 1 }], { email: EMAIL, ...extra }), JSON.stringify(extra)).toEqual({ status: 400, body: { ok: false, error: "invalid_input" } });
    }
    expect(await rows("SOA1")).toEqual([]);
  });

  it("整張退:申請金額是商品的實付金額,不含運費", async () => {
    await seedOrder("SOA2");
    await ask("SOA2", [{ productId: "p1", qty: 2 }, { productId: "p2", qty: 1 }]);
    expect((await rows("SOA2"))[0].requested_amount).toBe(675);
  });
});

describe("輸入與限速", () => {
  it("格式不對回 400;太大回 413", async () => {
    await seedOrder("SOI1");
    for (const body of [
      "not json",
      { action: "nope", orderNo: "SOI1", email: EMAIL },
      { action: "status", orderNo: "SO I1", email: EMAIL },
      { action: "status", orderNo: "SOI1", email: "not-an-email" },
      { action: "request", orderNo: "SOI1", email: EMAIL, lines: [{ productId: "p1", qty: 1 }], reason: "nope" },
      { action: "request", orderNo: "SOI1", email: EMAIL, lines: [{ productId: "p1", qty: 1.5 }], reason: "other" },
      { action: "request", orderNo: "SOI1", email: EMAIL, lines: [{ productId: "p1", qty: 1 }], reason: "other", note: "x".repeat(501) },
    ]) {
      expect(await call(body), JSON.stringify(body)).toEqual({ status: 400, body: { ok: false, error: "invalid_input" } });
    }
    expect((await call({ action: "status", orderNo: "SOI1", email: EMAIL, pad: "x".repeat(9000) })).status).toBe(413);
  });

  // 帶 Email 的認人額度(customer-order.ts):先照「訂單編號 + IP」、再照訂單編號各記一次,認對了兩筆都還回去。
  // 計數本身(猜錯幾次被擋、鎖不到客人自己)在 order-email-proof.test.ts 用真的計數表測。
  const { perClient, perOrder } = ORDER_EMAIL_PROOF_LIMITS;
  const proofHits = (orderNo: string): [string, string][] => [[`1.2.3.4|${orderNo}`, perClient.namespace], [orderNo, perOrder.namespace]];

  it("每一次都照 IP 記;帶 Email 的另外記認人的額度,認對了還回去(客人自己不用額度);申請再多記一筆", async () => {
    await seedOrder("SOL1");
    await call({ action: "status", orderNo: "SOL1", email: EMAIL });
    expect(limits.hits).toEqual([["1.2.3.4", CUSTOMER_RETURN_LIMITS.perIp.namespace], ...proofHits("SOL1")]);
    expect(limits.refunds).toEqual(proofHits("SOL1"));
    limits.hits = []; limits.refunds = [];
    await ask("SOL1", [{ productId: "p1", qty: 1 }]);
    expect(limits.hits).toEqual([["1.2.3.4", CUSTOMER_RETURN_LIMITS.perIp.namespace], ["1.2.3.4", CUSTOMER_RETURN_LIMITS.requestPerIp.namespace], ...proofHits("SOL1")]);
    expect(limits.refunds).toEqual(proofHits("SOL1"));
    // 沒帶 Email(會員,由訂單管理插件看登入的人):沒有憑證可猜,不記認人的額度。
    await seedOrder("SML0", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: "u-9", shippedAt: Date.now() }));
    limits.hits = []; limits.refunds = [];
    await call({ action: "status", orderNo: "SML0" });
    expect(limits.hits).toEqual([["1.2.3.4", CUSTOMER_RETURN_LIMITS.perIp.namespace]]);
    expect(limits.refunds).toEqual([]);
  });

  it("超過任何一個上限:429,不再往下查", async () => {
    await seedOrder("SOL2");
    for (const limit of [CUSTOMER_RETURN_LIMITS.perIp, CUSTOMER_RETURN_LIMITS.requestPerIp, perClient, perOrder]) {
      limits.blocked = new Set([limit.namespace]);
      expect(await ask("SOL2", [{ productId: "p1", qty: 1 }]), limit.namespace).toEqual({ status: 429, body: { ok: false, error: "rate_limited" } });
    }
    expect(await rows("SOL2")).toEqual([]);
  });

  it("被「訂單編號 + IP」那一份擋下來的不算進所有 IP 合計;被合計擋下來的,把自己那一筆還回去", async () => {
    await seedOrder("SOL4");
    limits.blocked = new Set([perClient.namespace]);
    await call({ action: "status", orderNo: "SOL4", email: EMAIL });
    expect(limits.hits.slice(1)).toEqual([[`1.2.3.4|SOL4`, perClient.namespace]]);
    expect(limits.refunds).toEqual([]);
    limits.hits = []; limits.blocked = new Set([perOrder.namespace]);
    await call({ action: "status", orderNo: "SOL4", email: EMAIL });
    expect(limits.hits.slice(1)).toEqual(proofHits("SOL4"));
    expect(limits.refunds).toEqual([[`1.2.3.4|SOL4`, perClient.namespace]]);
  });

  it("認人的額度在認人之前就記:訂單是誰的、存不存在,用掉的額度與被擋下的回應都一樣,猜錯的不還", async () => {
    await seedOrder("SOL3");
    await seedOrder("SML1", { managedBy: "mgr" });
    const asked = vi.fn(async (): Promise<Answer> => ({ ok: false }));
    manager.customerOrder = asked;
    for (const orderNo of ["SOL3", "SML1", "NOSUCH3"]) {
      limits.hits = [];
      expect(await call({ action: "status", orderNo, email: "guess@example.com" }), orderNo).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
      expect(limits.hits, orderNo).toEqual([["1.2.3.4", CUSTOMER_RETURN_LIMITS.perIp.namespace], ...proofHits(orderNo)]);
    }
    expect(limits.refunds).toEqual([]);
    expect(asked).toHaveBeenCalledTimes(1);
    // 額度滿了:三種都是 429,而且不去問訂單管理插件(它沒有機會、也不必自己再限一次)。
    for (const limit of [perClient, perOrder]) {
      asked.mockClear();
      limits.blocked = new Set([limit.namespace]);
      for (const orderNo of ["SOL3", "SML1", "NOSUCH3"]) {
        expect(await call({ action: "status", orderNo, email: EMAIL }), orderNo).toEqual({ status: 429, body: { ok: false, error: "rate_limited" } });
      }
      expect(asked).not.toHaveBeenCalled();
    }
  });

  it("訂單管理插件認到人(訪客帶 Email)也把額度還回去", async () => {
    await seedOrder("SML2", { managedBy: "mgr" });
    manager.customerOrder = vi.fn(async (): Promise<Answer> => ({ ok: true, memberId: null, shippedAt: Date.now() }));
    await call({ action: "status", orderNo: "SML2", email: EMAIL });
    expect(limits.refunds).toEqual(proofHits("SML2"));
  });
});

describe("客人看得到哪些退貨", () => {
  it("開放時:這張訂單所有的退貨(店家代建的也是他的退貨)", async () => {
    await seedOrder("SOV1");
    await createReturnsEngine(d1(), CONFIG).create(staff, { orderNo: "SOV1", lines: [{ productId: "p2", qty: 1 }], reason: "other", requestedAmount: 150 });
    await tick();
    await ask("SOV1", [{ productId: "p1", qty: 1 }]);
    expect(view(await call({ action: "status", orderNo: "SOV1", email: EMAIL })).returns.map((r) => r.lines)).toEqual([[{ name: "商品二", qty: 1 }], [{ name: "商品一", qty: 1 }]]);
  });

  it("店家之後關掉:這一區整個收起來,申請過的也不列(退貨本身還在退貨管理,照常處理)", async () => {
    await seedOrder("SOV2");
    await ask("SOV2", [{ productId: "p1", qty: 1 }]);
    settings[DAYS_KEY] = 0;
    expect(view(await call({ action: "status", orderNo: "SOV2", email: EMAIL }))).toEqual({ open: false, blocked: "closed", deadline: null, lines: [], returns: [] });
    expect(await createReturnsEngine(d1(), CONFIG).list({ status: "requested" })).toHaveLength(1);
  });
});

describe("商店的更新還沒套用(沒有退貨表)", () => {
  const BARE = { ordersTable: ORDERS, prefix: "ext_rcust_nothing" };

  it("查看:當作還沒有退貨,不開放;申請:一句說得出口的錯誤,不是 500", async () => {
    await seedOrder("SON1");
    expect(await call({ action: "status", orderNo: "SON1", email: EMAIL }, BARE)).toEqual({ status: 200, body: { ok: true, view: { open: false, blocked: "closed", deadline: null, lines: [], returns: [] } } });
    expect(await call({ action: "request", orderNo: "SON1", email: EMAIL, lines: [{ productId: "p1", qty: 1 }], reason: "other" }, BARE)).toEqual({ status: 503, body: { ok: false, error: "not_ready" } });
  });
});

describe("退貨引擎:客人申請", () => {
  it("訂單狀態先看,再看期限;期限是 null 就是不開放", async () => {
    await seedOrder("SOE1", { status: "paid" });
    await seedOrder("SOE2");
    const engine = createReturnsEngine(d1(), CONFIG);
    const input = { lines: [{ productId: "p1", qty: 1 }], reason: "other" as const, memberId: null };
    const code = async (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => (e instanceof ReturnError ? `${e.status} ${e.code}` : String(e)));
    expect(await code(engine.requestByCustomer({ ...input, orderNo: "SOE1", deadline: Date.now() - 1 }))).toBe("409 order_not_returnable");
    expect(await code(engine.requestByCustomer({ ...input, orderNo: "SOE2", deadline: Date.now() - 1 }))).toBe("409 window_passed");
    expect(await code(engine.requestByCustomer({ ...input, orderNo: "SOE2", deadline: null }))).toBe("409 closed");
    expect(await code(engine.requestByCustomer({ ...input, orderNo: "NOSUCH", deadline: Date.now() + DAY }))).toBe("404 order_not_found");
    expect(await rows("SOE2")).toEqual([]);
    const made = await engine.requestByCustomer({ ...input, orderNo: "SOE2", deadline: Date.now() + DAY });
    expect(made).toMatchObject({ status: "requested", createdBy: "customer", requestedAmount: 270 });
  });

  it("店家建立時照舊要給金額;ofOrder 列出一張訂單的退貨,舊的在前", async () => {
    await seedOrder("SOE3");
    const engine = createReturnsEngine(d1(), CONFIG);
    const a = await engine.create(staff, { orderNo: "SOE3", lines: [{ productId: "p1", qty: 1 }], reason: "other", requestedAmount: 300 });
    await tick();
    const b = await engine.requestByCustomer({ orderNo: "SOE3", lines: [{ productId: "p2", qty: 1 }], reason: "changed_mind", memberId: "u-1", deadline: Date.now() + DAY });
    expect(a).toMatchObject({ createdBy: "u-admin", requestedAmount: 300 });
    expect((await engine.ofOrder("SOE3")).map((r) => [r.returnNo, r.createdBy])).toEqual([[a.returnNo, "u-admin"], [b.returnNo, "customer:u-1"]]);
    expect(await engine.ofOrder("NOSUCH")).toEqual([]);
  });
});
