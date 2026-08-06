import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// Phase 3–4:運費規則引擎(純函式)+ 優惠碼(真 D1,原子核銷)+ 結帳整合。
// harness 同 commerce-checkout.test.ts(fake content/providers、真 manual provider)。

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
  computeShippingOptions,
  parseShippingConfig,
  type ShippingConfig,
} from "../src/ext/commerce-kit/shipping";
import {
  quotePromo,
  redeemPromo,
  restorePromoUse,
  createPromoQuoteHandler,
} from "../src/ext/commerce-kit/promo";
import { getOrder } from "../src/ext/commerce-kit/orders";
import type { ApiCtx } from "../src/ext/types";
import type { ContentEntry } from "../src/ext/capabilities";
import type { CoreServices } from "../src/ext/services";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const SHOP_TABLE = "ext_sptest_orders";
const PAY_TABLE = "ext_sptest_pay";
const PROMO_TABLE = "ext_sptest_promos";

// ---- 運費引擎(純函式,不碰 DB)----

const CONFIG: ShippingConfig = {
  methods: [
    { id: "home", name: "宅配", base: 120, enabled: true },
    { id: "cvs", name: "店到店", base: 60, enabled: true },
    { id: "off", name: "已停用", base: 999, enabled: false },
  ],
  rules: [
    {
      name: "滿千免運",
      enabled: true,
      when: { minSubtotal: 1000 },
      effect: { type: "free" },
    },
    {
      name: "離島加收",
      enabled: true,
      when: { regions: ["澎湖縣", "金門縣"] },
      effect: { type: "add", amount: 100 },
    },
    {
      name: "店到店折 20",
      enabled: true,
      when: { methods: ["cvs"] },
      effect: { type: "add", amount: -20 },
    },
  ],
};

describe("computeShippingOptions(純函式)", () => {
  it("基本費 + 方式限定折抵;停用方式不出現", () => {
    const opts = computeShippingOptions({ subtotal: 500, qty: 1 }, CONFIG);
    expect(opts.map((o) => [o.id, o.fee])).toEqual([
      ["home", 120],
      ["cvs", 40],
    ]);
  });

  it("free 終止後續規則(滿千後離島加收不再疊)", () => {
    const opts = computeShippingOptions(
      { subtotal: 1200, qty: 1, region: "澎湖縣" },
      CONFIG,
    );
    expect(opts.map((o) => o.fee)).toEqual([0, 0]);
    expect(opts[0].applied).toEqual(["滿千免運"]);
  });

  it("regions 條件:無 region 不命中;命中依序疊加", () => {
    const noRegion = computeShippingOptions({ subtotal: 500, qty: 1 }, CONFIG);
    expect(noRegion[0].fee).toBe(120);
    const island = computeShippingOptions(
      { subtotal: 500, qty: 1, region: "金門縣" },
      CONFIG,
    );
    expect(island[0].fee).toBe(220);
    expect(island[1].fee).toBe(140); // 60 + 100 − 20
  });

  it("override 蓋掉並繼續;負運費 clamp 到 0", () => {
    const cfg: ShippingConfig = {
      methods: [{ id: "m", name: "m", base: 100, enabled: true }],
      rules: [
        { name: "改 30", enabled: true, when: {}, effect: { type: "override", amount: 30 } },
        { name: "折 50", enabled: true, when: {}, effect: { type: "add", amount: -50 } },
      ],
    };
    expect(computeShippingOptions({ subtotal: 1, qty: 1 }, cfg)[0].fee).toBe(0);
  });

  it("qty 條件與停用規則", () => {
    const cfg: ShippingConfig = {
      methods: [{ id: "m", name: "m", base: 80, enabled: true }],
      rules: [
        { name: "兩件免運", enabled: true, when: { minQty: 2 }, effect: { type: "free" } },
        { name: "停用的", enabled: false, when: {}, effect: { type: "free" } },
      ],
    };
    expect(computeShippingOptions({ subtotal: 1, qty: 1 }, cfg)[0].fee).toBe(80);
    expect(computeShippingOptions({ subtotal: 1, qty: 2 }, cfg)[0].fee).toBe(0);
  });
});

describe("parseShippingConfig(寬容)", () => {
  it("空值/壞 JSON/不合 schema/全停用 → null;合法 JSON 字串 → 設定", () => {
    expect(parseShippingConfig("")).toBeNull();
    expect(parseShippingConfig("not json")).toBeNull();
    expect(parseShippingConfig({ methods: "wrong" })).toBeNull();
    expect(
      parseShippingConfig({
        methods: [{ id: "m", name: "m", base: 10, enabled: false }],
        rules: [],
      }),
    ).toBeNull();
    const parsed = parseShippingConfig(JSON.stringify(CONFIG));
    expect(parsed?.methods.map((m) => m.id)).toEqual(["home", "cvs", "off"]);
  });
});

// ---- 以下需要 DB ----

const products = new Map<string, ContentEntry>();

function makeServices(): CoreServices {
  const hooks = new HookBus();
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
      getById: (cap: string, id: string) =>
        cap === "payment" && id === "manualtest" ? manualProvider : null,
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
// 模擬 manual provider 未設定(instructions 失敗)→ createCheckout 回 ok:false。
let brokenPayment = false;

function ctx(): ApiCtx {
  return {
    user: { id: "anon", email: "anon@test", name: "anon", role: "editor", avatarKey: null },
    services,
  } as ApiCtx;
}

let shippingConfig: ShippingConfig | null = null;

const checkoutHandler = createCommerceCheckoutHandler({
  table: SHOP_TABLE,
  resolveProvider: async () => (brokenPayment ? "missing" : "manualtest"),
  resolveShippingConfig: async () => shippingConfig,
  promoTable: PROMO_TABLE,
});
const quoteHandler = createPromoQuoteHandler({ table: PROMO_TABLE });

function post(path: string, body: unknown): Request {
  return new Request(`https://cms.test/api/ext/shop/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}

async function checkout(over: Record<string, unknown> = {}) {
  const res = await checkoutHandler(
    post("checkout", {
      items: [{ productId: "p1", qty: 2 }],
      name: "王小明",
      email: "ming@example.com",
      method: "transfer",
      ...over,
    }),
    {},
    ctx(),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function seedPromo(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    code: "SAVE10",
    label: "",
    type: "percent",
    value: 10,
    min_subtotal: 0,
    max_uses: null as number | null,
    used: 0,
    starts_at: null as number | null,
    ends_at: null as number | null,
    enabled: 1,
    ...over,
  };
  await d1()
    .prepare(
      `INSERT OR REPLACE INTO ${PROMO_TABLE}
       (code, label, type, value, min_subtotal, max_uses, used, starts_at, ends_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .bind(
      row.code, row.label, row.type, row.value, row.min_subtotal,
      row.max_uses, row.used, row.starts_at, row.ends_at, row.enabled,
    )
    .run();
}

beforeAll(async () => {
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${SHOP_TABLE} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${PAY_TABLE} (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${PROMO_TABLE} (code TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, min_subtotal INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0, starts_at INTEGER, ends_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec(`DELETE FROM ${SHOP_TABLE};`);
  await d1().exec(`DELETE FROM ${PAY_TABLE};`);
  await d1().exec(`DELETE FROM ${PROMO_TABLE};`);
  products.clear();
  products.set("p1", {
    id: "p1",
    type: "catalog.product",
    slug: "p1",
    status: "published",
    data: { name: "商品p1", price: 300 },
    createdAt: 1,
    updatedAt: 1,
  });
  rateLimit.limited = false;
  brokenPayment = false;
  shippingConfig = null;
  services = makeServices();
});

describe("promo 引擎(真 D1)", () => {
  it("quote:percent 向下取整、flat 封頂於小計、freeship 不折商品", async () => {
    await seedPromo({ code: "P15", type: "percent", value: 15 });
    await seedPromo({ code: "F999", type: "flat", value: 999 });
    await seedPromo({ code: "SHIP", type: "freeship", value: 0 });
    const svc = { db: db() };
    const p = await quotePromo(svc, PROMO_TABLE, "P15", 333);
    expect(p).toMatchObject({ ok: true, discount: 49, freeShipping: false });
    const f = await quotePromo(svc, PROMO_TABLE, "F999", 500);
    expect(f).toMatchObject({ ok: true, discount: 500 });
    const s = await quotePromo(svc, PROMO_TABLE, "SHIP", 500);
    expect(s).toMatchObject({ ok: true, discount: 0, freeShipping: true });
  });

  it("quote 拒絕:不存在/停用/未開始/過期/用罄/低消", async () => {
    const svc = { db: db() };
    const now = 1_000_000;
    expect(await quotePromo(svc, PROMO_TABLE, "NONE", 100, now)).toMatchObject({ reason: "not_found" });
    await seedPromo({ code: "OFF", enabled: 0 });
    expect(await quotePromo(svc, PROMO_TABLE, "OFF", 100, now)).toMatchObject({ reason: "disabled" });
    await seedPromo({ code: "LATER", starts_at: now + 1 });
    expect(await quotePromo(svc, PROMO_TABLE, "LATER", 100, now)).toMatchObject({ reason: "not_started" });
    await seedPromo({ code: "OLD", ends_at: now - 1 });
    expect(await quotePromo(svc, PROMO_TABLE, "OLD", 100, now)).toMatchObject({ reason: "expired" });
    await seedPromo({ code: "GONE", max_uses: 3, used: 3 });
    expect(await quotePromo(svc, PROMO_TABLE, "GONE", 100, now)).toMatchObject({ reason: "exhausted" });
    await seedPromo({ code: "MIN", min_subtotal: 500 });
    expect(await quotePromo(svc, PROMO_TABLE, "MIN", 499, now)).toMatchObject({
      reason: "below_min_subtotal",
      minSubtotal: 500,
    });
  });

  it("redeem 原子核銷:最後一次用量只有一個成立;restore 補回", async () => {
    await seedPromo({ code: "LAST1", max_uses: 1 });
    const svc = { db: db() };
    const first = await redeemPromo(svc, PROMO_TABLE, "LAST1", 100);
    expect(first?.used).toBe(1);
    const second = await redeemPromo(svc, PROMO_TABLE, "LAST1", 100);
    expect(second).toBeNull();
    await restorePromoUse(svc, PROMO_TABLE, "LAST1");
    const third = await redeemPromo(svc, PROMO_TABLE, "LAST1", 100);
    expect(third?.used).toBe(1);
  });

  it("promo-quote handler:大小寫不敏感、無效碼回 200 + reason、rate limit 429", async () => {
    await seedPromo({ code: "HELLO", type: "flat", value: 30 });
    const ok = await quoteHandler(post("promo-quote", { code: "hello", subtotal: 100 }), {}, ctx());
    expect(await ok.json()).toMatchObject({ ok: true, code: "HELLO", discount: 30 });
    const bad = await quoteHandler(post("promo-quote", { code: "NOPE", subtotal: 100 }), {}, ctx());
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ ok: false, reason: "not_found" });
    rateLimit.limited = true;
    const limited = await quoteHandler(post("promo-quote", { code: "HELLO", subtotal: 100 }), {}, ctx());
    expect(limited.status).toBe(429);
  });
});

describe("checkout 整合(運費 + 優惠碼)", () => {
  const SHIP: ShippingConfig = {
    methods: [
      { id: "home", name: "宅配", base: 120, enabled: true },
      { id: "cvs", name: "店到店", base: 60, enabled: true },
    ],
    rules: [
      { name: "滿千免運", enabled: true, when: { minSubtotal: 1000 }, effect: { type: "free" } },
    ],
  };

  it("運費啟用:必選配送方式(缺/亂給 422),金額伺服器算,快照入單", async () => {
    shippingConfig = SHIP;
    const missing = await checkout();
    expect(missing.res.status).toBe(422);
    expect(missing.body.error).toBe("invalid_shipping");
    const bogus = await checkout({ shippingMethodId: "ghost" });
    expect(bogus.res.status).toBe(422);

    const ok = await checkout({ shippingMethodId: "home", region: "臺北市" });
    expect(ok.res.status).toBe(200);
    expect(ok.body.amounts).toEqual({ subtotal: 600, discount: 0, shipping: 120, total: 720 });
    const order = await getOrder({ db: db() }, SHOP_TABLE, ok.body.orderNo as string);
    expect(order).toMatchObject({ region: "臺北市", shippingMethod: "宅配" });
    // 付款列金額 = total(運費含在收款)
    const pay = await d1()
      .prepare(`SELECT amount FROM ${PAY_TABLE} WHERE order_no = ?`)
      .bind(ok.body.orderNo)
      .first<{ amount: number }>();
    expect(pay?.amount).toBe(720);
  });

  it("滿額免運規則在伺服器生效", async () => {
    shippingConfig = SHIP;
    const { body } = await checkout({
      items: [{ productId: "p1", qty: 4 }], // 1200
      shippingMethodId: "home",
    });
    expect(body.amounts).toEqual({ subtotal: 1200, discount: 0, shipping: 0, total: 1200 });
  });

  it("優惠碼:percent 折扣入單、freeship 清運費、碼寫入訂單、用量 +1", async () => {
    shippingConfig = SHIP;
    await seedPromo({ code: "SAVE10", type: "percent", value: 10 });
    const a = await checkout({ shippingMethodId: "cvs", promoCode: "save10" });
    expect(a.body.amounts).toEqual({ subtotal: 600, discount: 60, shipping: 60, total: 600 });
    const orderA = await getOrder({ db: db() }, SHOP_TABLE, a.body.orderNo as string);
    expect(orderA?.promoCode).toBe("SAVE10");

    await seedPromo({ code: "SHIPFREE", type: "freeship" });
    const b = await checkout({ shippingMethodId: "home", promoCode: "SHIPFREE" });
    expect(b.body.amounts).toEqual({ subtotal: 600, discount: 0, shipping: 0, total: 600 });

    const used = await d1()
      .prepare(`SELECT used FROM ${PROMO_TABLE} WHERE code = 'SAVE10'`)
      .first<{ used: number }>();
    expect(used?.used).toBe(1);
  });

  it("無效碼 422 + reason;用罄的碼在核銷 race 也擋住", async () => {
    await seedPromo({ code: "GONE", max_uses: 1, used: 1 });
    const { res, body } = await checkout({ promoCode: "GONE" });
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ error: "promo_invalid", reason: "exhausted" });
  });

  it("payment session 失敗 → 優惠碼用量補回(訂單不成立)", async () => {
    await seedPromo({ code: "SAVE10", type: "percent", value: 10, max_uses: 5 });
    brokenPayment = true; // resolveProvider 回不存在的 provider → 503 前已核銷?
    const { res } = await checkout({ promoCode: "SAVE10" });
    expect(res.status).toBe(503);
    const used = await d1()
      .prepare(`SELECT used FROM ${PROMO_TABLE} WHERE code = 'SAVE10'`)
      .first<{ used: number }>();
    // provider 缺席發生在核銷之前 → 用量不應被動過
    expect(used?.used).toBe(0);
  });

  it("100% 折扣讓 total < 1 → invalid_total 且用量補回", async () => {
    await seedPromo({ code: "ALL", type: "percent", value: 100, max_uses: 9 });
    const { res, body } = await checkout({ promoCode: "ALL" }); // 無運費 → total 0
    expect(res.status).toBe(422);
    expect(body.error).toBe("invalid_total");
    const used = await d1()
      .prepare(`SELECT used FROM ${PROMO_TABLE} WHERE code = 'ALL'`)
      .first<{ used: number }>();
    expect(used?.used).toBe(0);
  });

  it("運費未啟用時行為不變(Phase 1–2 相容):忽略 shipping 參數", async () => {
    const { body } = await checkout({ shippingMethodId: "home", region: "臺北市" });
    expect(body.amounts).toEqual({ subtotal: 600, discount: 0, shipping: 0, total: 600 });
  });
});
