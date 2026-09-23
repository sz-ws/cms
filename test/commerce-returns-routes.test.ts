import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 退貨 API(commerce-kit 1.50.0)走真的 ext API dispatcher:誰能呼叫(未登入 401、
// guest 403、editor 403、admin 可以)、跨源擋下、輸入驗證,以及 admin 從建立到收到退貨、
// 經 providers registry 找到的庫存 provider 放回庫存。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/lib/settings", () => ({
  getSetting: async (_key: string, fallback?: unknown) => fallback,
  setSettings: async () => {},
}));

type Role = "admin" | "editor" | "guest";
const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; role: Role; avatarKey: null } }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  const rank: Record<Role, number> = { guest: 0, editor: 1, admin: 2 };
  return {
    ...actual,
    // 與真的 requireAuth 同規則:沒登入 401,角色不夠 403。
    requireAuth: async (minRole: Role = "editor") => {
      if (!auth.user) throw new actual.AuthError(401);
      if (rank[auth.user.role] < rank[minRole]) throw new actual.AuthError(403);
      return auth.user;
    },
  };
});

const setup = vi.hoisted(() => ({ ordersTable: "ext_rtroute_orders", stockPrefix: "ext_rtroute_stock" }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { defineExtension } = await import("../src/ext/types");
  const { createReturnsApiRoutes } = await import("../src/ext/commerce-kit/returns-api");
  const { createLedgerProvider } = await import("../src/ext/ledger-kit");
  const db = (env as { DB: D1Database }).DB;
  const item = (sku: string) => ({ id: sku, owner: { type: "sku", id: sku }, unit: "item", precision: 0 });
  const shop = defineExtension({
    id: "rtshop",
    name: "rtshop",
    version: "0.0.1",
    coreApi: "^1.50.0",
    apiRoutes: createReturnsApiRoutes({ ordersTable: setup.ordersTable, prefix: "ext_shop_return" }),
  });
  // 和庫存插件同一個 capability / id,形狀是 RestockProvider。
  const stock = defineExtension({
    id: "rtstock",
    name: "rtstock",
    version: "0.0.1",
    coreApi: "^1.50.0",
    provides: [
      {
        capability: "inventory",
        id: "inventory",
        create: () => {
          const ledger = createLedgerProvider(db, setup.stockPrefix);
          return {
            prepareRestock: (sku: string, qty: number) => ledger.prepareCredit(item(sku), String(qty)),
            getBalance: (sku: string) => ledger.getBalance(item(sku)),
            getReservation: (sku: string, reservationId: string) => ledger.getReservation(item(sku), reservationId),
            prepareOpen: (sku: string) => ledger.prepareOpen(item(sku)),
          };
        },
      },
    ],
  });
  const rt = {
    enabled: [shop, stock],
    all: [shop, stock],
    hooks: new HookBus(),
    byId: (id: string) => [shop, stock].find((e) => e.id === id),
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return { getExtRuntime: async () => rt };
});

import { GET, POST } from "../src/app/api/ext/[extId]/[[...path]]/route";
import { commitLedgerOperations, createLedgerProvider, ledgerAdjustmentSchema, ledgerSchema } from "../src/ext/ledger-kit";
import { createReturnsApiRoutes } from "../src/ext/commerce-kit/returns-api";
import { RETURN_STATUS_SET, orderStockReservationId } from "../src/ext/commerce-kit/returns";
import { defineExtension } from "../src/ext/types";
import { shopMigrations } from "../extensions/shop/schema";
import { SHOP_RETURNS, SHOP_RETURNS_SEARCH } from "../extensions/shop/returns-config";

const ORIGIN = "https://cms.test";
const d1 = () => (env as { DB: D1Database }).DB;
const user = (role: Role) => ({ id: `u-${role}`, email: `${role}@t.co`, name: role === "admin" ? "店長" : role, role, avatarKey: null });

function call(method: "GET" | "POST", path: string, body?: unknown, origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.origin = origin;
  const req = new Request(`${ORIGIN}/api/ext/rtshop/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = { params: Promise.resolve({ extId: "rtshop", path: path.split("/") }) };
  return method === "GET" ? GET(req, ctx) : POST(req, ctx);
}

async function run(statements: string) {
  for (const sql of statements.split(";").map((s) => s.trim()).filter(Boolean)) await d1().prepare(sql).run();
}

const item = (sku: string) => ({ id: sku, owner: { type: "sku", id: sku }, unit: "item", precision: 0 });

beforeAll(async () => {
  await run(shopMigrations.find((m) => m.id === "0004_returns")!.sql);
  await run(
    `CREATE TABLE IF NOT EXISTS ${setup.ordersTable} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL, lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  await run(`${ledgerSchema(setup.stockPrefix, { adjustments: false })};${ledgerAdjustmentSchema(setup.stockPrefix)}`);
  const now = Date.now();
  await d1()
    .prepare(
      `INSERT INTO ${setup.ordersTable} (order_no, status, lines, subtotal, total, payment_provider, customer_name, customer_email, customer_phone, created_at, updated_at)
       VALUES ('SOR1', 'shipped', ?, 600, 600, 'banktransfer', '陳小華', 'hua@example.com', '0922000111', ?, ?)`,
    )
    .bind(JSON.stringify([{ productId: "p1", name: "商品一", unitPrice: 300, qty: 2 }]), now, now)
    .run();
  const ledger = createLedgerProvider(d1(), setup.stockPrefix);
  await commitLedgerOperations({ id: "rt:open:p1", actor: { type: "user", id: "t" }, reason: "seed" }, [ledger.prepareOpen(item("p1"))]);
  await commitLedgerOperations({ id: "rt:seed:p1", actor: { type: "user", id: "t" }, reason: "seed" }, [ledger.prepareCredit(item("p1"), "3")]);
  // 這張訂單從庫存扣走 2 件(預留 → 扣下),退貨才能放回。
  const reservation = orderStockReservationId("SOR1", "p1");
  await commitLedgerOperations({ id: "rt:reserve:p1", actor: { type: "user", id: "t" }, reason: "order" }, [ledger.prepareReserve(item("p1"), reservation, "2", { type: "NORMAL_ORDER", id: "SOR1" })]);
  await commitLedgerOperations({ id: "rt:capture:p1", actor: { type: "user", id: "t" }, reason: "paid" }, [ledger.prepareCapture(item("p1"), reservation)]);
});

beforeEach(() => {
  auth.user = null;
});

describe("退貨 API 權限", () => {
  it("商店用的退貨宣告(路由、搜尋、狀態組)過得了 manifest 驗證,路由沒有一條是公開的", () => {
    // 商店的 index.ts 帶著 .tsx 頁面(next/navigation),workers 測試池載不起來;
    // 這裡用它實際引用的同一批宣告組一個 manifest 驗。
    const routes = createReturnsApiRoutes(SHOP_RETURNS);
    expect(() =>
      defineExtension({
        id: "shop",
        name: "shop",
        version: "0.6.0",
        coreApi: "^1.50.0",
        adminPages: [{ slug: "returns", title: { en: "Returns", "zh-Hant": "退貨管理" }, component: () => null, search: SHOP_RETURNS_SEARCH }],
        apiRoutes: routes,
        statusSets: [RETURN_STATUS_SET],
      }),
    ).not.toThrow();
    expect(SHOP_RETURNS_SEARCH.global?.table).toBe("ext_shop_return_requests");
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET returns/order/:orderNo",
      "GET returns/:returnNo",
      "POST returns",
      "POST returns/:returnNo/status",
    ]);
    expect(routes.every((r) => r.public !== true)).toBe(true);
  });

  it("未登入 401、guest 403(dispatcher);editor 403(退貨只給 admin)", async () => {
    expect((await call("GET", "returns/order/SOR1")).status).toBe(401);
    auth.user = user("guest");
    expect((await call("GET", "returns/order/SOR1")).status).toBe(403);
    auth.user = user("editor");
    const res = await call("POST", "returns", { orderNo: "SOR1", lines: [{ productId: "p1", qty: 1 }], reason: "other", requestedAmount: 300 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "forbidden" });
    expect((await d1().prepare("SELECT COUNT(*) AS n FROM ext_shop_return_requests WHERE order_no = 'SOR1'").first<{ n: number }>())?.n).toBe(0);
  });

  it("跨源的寫入一律擋下", async () => {
    auth.user = user("admin");
    const res = await call("POST", "returns", { orderNo: "SOR1", lines: [{ productId: "p1", qty: 1 }], reason: "other", requestedAmount: 300 }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});

describe("退貨 API(admin)", () => {
  it("輸入不合法回 400,找不到回 404", async () => {
    auth.user = user("admin");
    expect((await call("POST", "returns", { orderNo: "SOR1", lines: [], reason: "other", requestedAmount: 1 })).status).toBe(400);
    expect((await call("POST", "returns", { orderNo: "SOR1", lines: [{ productId: "p1", qty: 1 }], reason: "nope", requestedAmount: 1 })).status).toBe(400);
    expect((await call("GET", "returns/order/NOPE")).status).toBe(404);
    expect((await call("GET", "returns/RTNOPE1")).status).toBe(404);
    expect((await call("POST", "returns/RTNOPE1/status", { to: "shipped" })).status).toBe(400);
  });

  it("查訂單 → 建立 → 同意 → 收到並放回庫存(經 providers registry 找到庫存)", async () => {
    auth.user = user("admin");
    const lookup = await (await call("GET", "returns/order/SOR1")).json() as {
      ok: boolean;
      order: { eligible: boolean; lines: { productId: string; returnable: number }[] };
      stock: { enabled: boolean; tracked: Record<string, boolean>; taken: Record<string, boolean> };
    };
    expect(lookup).toMatchObject({ ok: true, order: { eligible: true, lines: [{ productId: "p1", returnable: 2 }] }, stock: { enabled: true, tracked: { p1: true }, taken: { p1: true } } });

    const created = await (await call("POST", "returns", { orderNo: "SOR1", lines: [{ productId: "p1", qty: 2 }], reason: "wrong_item", requestedAmount: 600 })).json() as { ok: boolean; return: { returnNo: string; status: string } };
    expect(created).toMatchObject({ ok: true, return: { status: "requested" } });
    const no = created.return.returnNo;

    expect((await call("POST", `returns/${no}/status`, { to: "approved" })).status).toBe(200);
    const received = await call("POST", `returns/${no}/status`, { to: "received", restock: [{ productId: "p1", qty: 2 }] });
    expect(received.status).toBe(200);
    const balance = await createLedgerProvider(d1(), setup.stockPrefix).getBalance(item("p1"));
    expect(balance?.available).toBe("3");

    const detail = await (await call("GET", `returns/${no}`)).json() as { return: { status: string }; events: { action: string; actorName: string }[]; order: { total: number } };
    expect(detail.return.status).toBe("received");
    // 退款上限(商品 + 運費)在後台算:訂單的商品金額與折扣跟著明細一起給。
    expect(detail.order).toEqual({ status: "shipped", subtotal: 600, discount: 0, total: 600, refunded: 0 });
    expect(detail.events.map((e) => [e.action, e.actorName])).toEqual([["created", "店長"], ["approved", "店長"], ["received", "店長"]]);

    const illegal = await call("POST", `returns/${no}/status`, { to: "approved" });
    expect(illegal.status).toBe(409);
    expect(await illegal.json()).toEqual({ ok: false, error: "illegal_transition" });
  });

  it("退一件 150 元的商品:申請與退款最多 150,不是整張訂單的 450", async () => {
    auth.user = user("admin");
    const now = Date.now();
    await d1()
      .prepare(
        `INSERT INTO ${setup.ordersTable} (order_no, status, lines, subtotal, total, payment_provider, customer_name, customer_email, customer_phone, created_at, updated_at)
         VALUES ('SOR2', 'completed', ?, 450, 450, 'banktransfer', '陳小華', 'hua@example.com', '0922000111', ?, ?)`,
      )
      .bind(JSON.stringify([{ productId: "p9", name: "商品九", unitPrice: 150, qty: 3 }]), now, now)
      .run();
    const body = (requestedAmount: number) => ({ orderNo: "SOR2", lines: [{ productId: "p9", qty: 1 }], reason: "other", requestedAmount });

    const tooMuch = await call("POST", "returns", body(450));
    expect(tooMuch.status).toBe(409);
    expect(await tooMuch.json()).toEqual({ ok: false, error: "amount_exceeds" });
    const created = await (await call("POST", "returns", body(150))).json() as { ok: boolean; return: { returnNo: string } };
    expect(created.ok).toBe(true);
    const no = created.return.returnNo;

    expect((await call("POST", `returns/${no}/status`, { to: "approved" })).status).toBe(200);
    const over = await call("POST", `returns/${no}/status`, { to: "refunded", refund: { amount: 151, method: "cash" } });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ ok: false, error: "amount_exceeds" });
    expect((await call("POST", `returns/${no}/status`, { to: "refunded", refund: { amount: 150, method: "cash" } })).status).toBe(200);
  });
});
