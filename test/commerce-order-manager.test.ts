import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// commerce-kit 1.63.0:訂單管理插件(OrderManager,capability commerce:orders)。一筆訂單歸誰看訂單列的
// managed_by;1.63.0 以前的站看 `<表>_managed` 標記表(legacy-ownership.ts,2.0 拿掉)。
// 真 D1;extension runtime 與 provider registry 換成替身(誰啟用、誰提供哪張表)。

vi.mock("@/lib/cf", () => ({ getEnv: () => env, getDB: () => (env as { DB: unknown }).DB }));
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => false }));

const TABLE = "ext_omtest_orders";
const LEGACY = "ext_omold_orders";

const manager = vi.hoisted(() => ({
  transition: vi.fn(async () => true),
  checkout: vi.fn(async () => Response.json({ ok: true, managed: true })),
  reportTransfer: vi.fn(async () => Response.json({ ok: true, managedReport: true })) as ReturnType<typeof vi.fn> | undefined,
}));
const world = vi.hoisted(() => ({ enabled: ["mgr"] as string[] }));

vi.mock("@/ext/loader", () => {
  const ext = (id: string, name: string, tables: string[]) => ({
    id, name, version: "1.0.0", coreApi: "^1.63.0",
    provides: tables.map((table) => ({ capability: "commerce:orders", id: table, create: () => manager })),
  });
  const all = [ext("mgr", "訂單管理", ["ext_omtest_orders", "ext_omold_orders"]), ext("other", "別的插件", [])];
  return {
    getExtRuntime: async () => ({
      all,
      enabled: all.filter((e) => world.enabled.includes(e.id)),
      byId: (id: string) => all.find((e) => e.id === id && world.enabled.includes(id)),
    }),
  };
});
vi.mock("@/ext/services", () => ({
  buildProviderRegistry: () => ({
    getById: (capability: string, id: string) =>
      capability === "commerce:orders" && world.enabled.includes("mgr") && (id === "ext_omtest_orders" || id === "ext_omold_orders") ? manager : null,
  }),
}));

import { db } from "../src/lib/db";
import { createOrder, getOrder, transitionOrder } from "../src/ext/commerce-kit/orders";
import { OrderManagedError, resolveOrderOwner, storefrontOf, type OrderManager } from "../src/ext/commerce-kit/order-manager";
import { createCommerceCheckoutHandler } from "../src/ext/commerce-kit/checkout";
import { createOrderStatusHandler, createTransferReportHandler, createTransferVerifyHandler } from "../src/ext/commerce-kit/transfer";
import type { ApiCtx } from "../src/ext/types";
import type { CoreServices } from "../src/ext/services";

const d1 = () => (env as { DB: D1Database }).DB;
const deps = () => ({ db: db() });
const COLUMNS = "order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL";

async function seed(table: string, orderNo: string, managedBy?: string) {
  await createOrder(deps(), table, {
    orderNo,
    lines: [{ productId: "p1", name: "商品", unitPrice: 100, qty: 1 }],
    amounts: { subtotal: 100, discount: 0, shipping: 0, total: 100 },
    paymentProvider: "banktransfer",
    customerName: "王小明",
    customerEmail: "ming@example.com",
  });
  if (managedBy) await d1().prepare(`UPDATE ${table} SET managed_by = ? WHERE order_no = ?`).bind(managedBy, orderNo).run();
}

function ctx(providers: Record<string, unknown> = {}): ApiCtx {
  return {
    user: { id: "anonymous", email: "anonymous@public", name: "Anonymous", role: "editor", avatarKey: null },
    services: {
      db: db(),
      providers: {
        list: () => [],
        getById: (capability: string, id: string) => providers[`${capability}:${id}`] ?? null,
      },
    } as unknown as CoreServices,
  } as ApiCtx;
}
const json = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify(body) });

beforeAll(async () => {
  // TABLE:套用過 shop 0007(有 managed_by)。LEGACY:還沒套用,只有舊的標記表。
  await d1().exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (${COLUMNS}, managed_by TEXT);`);
  await d1().exec(`CREATE TABLE IF NOT EXISTS ${LEGACY} (${COLUMNS});`);
  await d1().exec(`CREATE TABLE IF NOT EXISTS ${LEGACY}_managed (order_no TEXT PRIMARY KEY);`);
});

beforeEach(async () => {
  for (const table of [TABLE, LEGACY, `${LEGACY}_managed`]) await d1().exec(`DELETE FROM ${table};`);
  world.enabled = ["mgr"];
  manager.transition.mockClear();
  manager.checkout.mockClear();
  manager.reportTransfer = vi.fn(async () => Response.json({ ok: true, managedReport: true }));
});

describe("resolveOrderOwner", () => {
  it("managed_by empty: core; set and the plugin is on: that plugin; set and it is off: unavailable, named", async () => {
    await seed(TABLE, "SOCORE1");
    await seed(TABLE, "SMMGR01", "mgr");
    expect(await resolveOrderOwner(deps(), TABLE, "SOCORE1")).toEqual({ kind: "core" });
    expect(await resolveOrderOwner(deps(), TABLE, "SMMGR01")).toMatchObject({ kind: "managed" });
    world.enabled = [];
    expect(await resolveOrderOwner(deps(), TABLE, "SMMGR01")).toEqual({ kind: "unavailable", name: "訂單管理" });
    expect(await resolveOrderOwner(deps(), TABLE, "NOSUCH")).toEqual({ kind: "core" });
  });

  it("managed_by names a plugin that does not manage this table: unavailable, never someone else's manager", async () => {
    await seed(TABLE, "SMOTHER", "other");
    world.enabled = ["mgr", "other"];
    expect(await resolveOrderOwner(deps(), TABLE, "SMOTHER")).toEqual({ kind: "unavailable", name: "別的插件" });
  });

  it("before 套用更新 (no managed_by column): the old marker table still decides", async () => {
    await seed(LEGACY, "SOLEGACYCORE");
    await seed(LEGACY, "SMLEGACY1");
    await d1().prepare(`INSERT INTO ${LEGACY}_managed (order_no) VALUES ('SMLEGACY1')`).run();
    expect(await resolveOrderOwner(deps(), LEGACY, "SOLEGACYCORE")).toEqual({ kind: "core" });
    expect(await resolveOrderOwner(deps(), LEGACY, "SMLEGACY1")).toMatchObject({ kind: "managed" });
    world.enabled = [];
    expect(await resolveOrderOwner(deps(), LEGACY, "SMLEGACY1")).toEqual({ kind: "unavailable", name: "訂單管理" });
  });
});

describe("transitionOrder routes by owner", () => {
  it("the manager transitions its orders; core its own; an unavailable manager is an error, the order untouched", async () => {
    await seed(TABLE, "SOCORE1");
    await seed(TABLE, "SMMGR01", "mgr");
    expect(await transitionOrder(deps(), TABLE, "SMMGR01", "cancelled", { note: "x" })).toBe(true);
    expect(manager.transition).toHaveBeenCalledWith("SMMGR01", "cancelled", { note: "x" });
    expect((await getOrder(deps(), TABLE, "SMMGR01"))?.status).toBe("pending_payment");
    expect(await transitionOrder(deps(), TABLE, "SOCORE1", "cancelled")).toBe(true);
    expect((await getOrder(deps(), TABLE, "SOCORE1"))?.status).toBe("cancelled");

    world.enabled = [];
    await expect(transitionOrder(deps(), TABLE, "SMMGR01", "paid")).rejects.toBeInstanceOf(OrderManagedError);
    expect((await getOrder(deps(), TABLE, "SMMGR01"))?.status).toBe("pending_payment");
  });
});

describe("checkout", () => {
  const handler = createCommerceCheckoutHandler({ table: TABLE, resolveProvider: async () => "" });
  const legacyHandler = createCommerceCheckoutHandler({ table: LEGACY, resolveProvider: async () => "" });
  const body = { items: [{ productId: "p1", qty: 1 }], name: "A", email: "a@example.com", method: "transfer" };

  it("a registered manager takes the whole checkout", async () => {
    const res = await handler(json("https://cms.test/checkout", body), {}, ctx({ [`commerce:orders:${TABLE}`]: manager }));
    expect(await res.json()).toEqual({ ok: true, managed: true });
    expect(manager.checkout).toHaveBeenCalledTimes(1);
  });

  it("no manager but orders it managed: paused (503 checkout_paused), with or without the new column", async () => {
    await seed(TABLE, "SMMGR01", "mgr");
    const paused = await handler(json("https://cms.test/checkout", body), {}, ctx());
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ ok: false, error: "checkout_paused", message: "目前暫停結帳，請稍後再試。" });
    const legacy = await legacyHandler(json("https://cms.test/checkout", body), {}, ctx());
    expect(legacy.status).toBe(503);
  });

  it("nobody ever managed orders: core checks out (here: no payment method → 422)", async () => {
    await seed(TABLE, "SOCORE1");
    const res = await handler(json("https://cms.test/checkout", body), {}, {
      ...ctx(),
      services: { ...ctx().services, providers: { list: () => [], getById: () => null, get: () => ({ get: async () => ({ status: "published", data: { name: "商品", price: 100 } }) }) } },
    } as unknown as ApiCtx);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "method_not_enabled" });
  });
});

describe("transfer report, verify and status for managed orders", () => {
  const report = createTransferReportHandler({ table: TABLE });
  const verify = createTransferVerifyHandler({ table: TABLE, resolveTransferProvider: async () => "bank" });
  const status = createOrderStatusHandler({ table: TABLE });

  it("a report on a managed order goes to its manager with the raw values (last5 read as reference)", async () => {
    await seed(TABLE, "SMMGR01", "mgr");
    const res = await report(json("https://cms.test/transfer-report", { orderNo: "SMMGR01", last5: "12345", payerName: "王", email: "a@example.com" }), {}, ctx());
    expect(await res.json()).toEqual({ ok: true, managedReport: true });
    expect(manager.reportTransfer).toHaveBeenCalledWith({ orderNo: "SMMGR01", reference: "12345", payerName: "王", email: "a@example.com" }, expect.any(Request), expect.anything());
  });

  it("a manager without reportTransfer, or one that is off: 409 order_managed, in words for the customer (no plugin, nothing to enable)", async () => {
    await seed(TABLE, "SMMGR01", "mgr");
    manager.reportTransfer = undefined;
    const without = await report(json("https://cms.test/transfer-report", { orderNo: "SMMGR01", reference: "12345" }), {}, ctx());
    expect(without.status).toBe(409);
    expect(await without.json()).toEqual({ ok: false, error: "order_managed", message: "這筆訂單目前無法回報匯款，請聯絡店家。" });
    world.enabled = [];
    const off = await report(json("https://cms.test/transfer-report", { orderNo: "SMMGR01", reference: "12345" }), {}, ctx());
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ ok: false, error: "order_managed", message: "這筆訂單目前無法回報匯款，請聯絡店家。" });
  });

  it("the shop's own verify refuses managed orders; status on an unavailable manager is 409, not a crash", async () => {
    await seed(TABLE, "SMMGR01", "mgr");
    const verified = await verify(json("https://cms.test/verify", { approve: true }), { orderNo: "SMMGR01" }, ctx());
    expect(verified.status).toBe(409);
    expect(await verified.json()).toMatchObject({ error: "order_managed" });
    world.enabled = [];
    const moved = await status(json("https://cms.test/status", { to: "cancelled" }), { orderNo: "SMMGR01" }, ctx());
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: "order_managed", message: "這筆訂單由「訂單管理」處理，請先啟用它。" });
  });
});

describe("table names are checked before they reach SQL", () => {
  it("hasManagedOrders and resolveOrderOwner refuse a table name that is not a plain identifier", async () => {
    const { hasManagedOrders } = await import("../src/ext/commerce-kit/order-manager");
    for (const bad of ["x; DROP TABLE users", "ext_orders WHERE 1=1 --", "A", ""]) {
      await expect(hasManagedOrders({ db: db() }, bad)).rejects.toThrow(/invalid orders table name/);
      await expect(resolveOrderOwner({ db: db() }, bad, "SO1")).rejects.toThrow(/invalid orders table name/);
    }
  });
});

describe("storefrontOf", () => {
  const base: OrderManager = { checkout: async () => new Response(), transition: async () => true };

  it("takes the manager's answer, falling back to safe values for anything off", async () => {
    expect(await storefrontOf({ ...base, storefront: async () => ({ signIn: "optional", requireContact: false, ordersHref: "/orders" }) })).toEqual({ signIn: "optional", requireContact: false, ordersHref: "/orders" });
    const odd = { ...base, storefront: async () => ({ signIn: "maybe", requireContact: "no", ordersHref: "https://evil.example/orders" }) } as unknown as OrderManager;
    expect(await storefrontOf(odd)).toEqual({ signIn: "required", requireContact: true, ordersHref: null });
    expect(await storefrontOf({ ...base, storefront: async () => ({ signIn: "required", requireContact: true, ordersHref: "//evil.example" }) })).toMatchObject({ ordersHref: null });
    // Browsers read a backslash as a slash: /\evil.example is another site.
    for (const href of ["/\\evil.example", "/orders\\x", "/\t/evil.example", "orders"]) {
      expect(await storefrontOf({ ...base, storefront: async () => ({ signIn: "required", requireContact: true, ordersHref: href }) })).toMatchObject({ ordersHref: null });
    }
  });

  it("deprecated until 2.0: a manager without storefront() is asked guestCheckout(), no orders page", async () => {
    expect(await storefrontOf(base)).toEqual({ signIn: "required", requireContact: true, ordersHref: null });
    const guest = { ...base, guestCheckout: async () => true } as OrderManager;
    expect(await storefrontOf(guest)).toEqual({ signIn: "optional", requireContact: true, ordersHref: null });
  });
});
