import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// payment-kit manual 引擎(1.28.0)的 binding-backed 測試:createCheckout 寫入
// pending 付款列 + 回 kind:"manual";settleManual 走統一結算(冪等、hook 帶
// orderNo、fail 不觸發 hook)。真 D1、真 HookBus,僅 cf binding 以 mock 接上。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { db } from "../src/lib/db";
import { HookBus } from "../src/ext/hooks";
import { createManualPaymentProvider } from "../src/ext/payment-kit/manual";
import type { CoreServices } from "../src/ext/services";
import type { ManualInstructionsResult } from "../src/ext/payment-kit/manual";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const TABLE = "ext_manualtest_orders";

const state = {
  hookEvents: [] as unknown[],
  instructions: {
    ok: true,
    instructions: [{ label: "帳號", value: "123-456" }],
    note: "備註",
  } as ManualInstructionsResult,
};

function makeServices(): CoreServices {
  const hooks = new HookBus();
  hooks.register("observer", "payment:succeeded", (payload: unknown) => {
    state.hookEvents.push(payload);
  });
  return { db: db(), hooks } as unknown as CoreServices;
}

function makeProvider(services: CoreServices) {
  return createManualPaymentProvider({
    services,
    providerId: "manualtest",
    table: TABLE,
    instructions: async () => state.instructions,
  });
}

async function row(orderNo: string) {
  return d1()
    .prepare(
      `SELECT status, payment_type, raw_result FROM ${TABLE} WHERE order_no = ?`,
    )
    .bind(orderNo)
    .first<{ status: string; payment_type: string | null; raw_result: string | null }>();
}

beforeAll(async () => {
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec(`DELETE FROM ${TABLE};`);
  state.hookEvents = [];
  state.instructions = {
    ok: true,
    instructions: [{ label: "帳號", value: "123-456" }],
    note: "備註",
  };
});

describe("createManualPaymentProvider", () => {
  it("createCheckout 回 manual session 並寫入 pending 付款列", async () => {
    const provider = makeProvider(makeServices());
    const session = await provider.createCheckout({
      orderNo: "MT1",
      amount: 500,
      description: "測試",
      email: "a@b.c",
    });
    expect(session).toMatchObject({
      ok: true,
      kind: "manual",
      providerId: "manualtest",
      instructions: [{ label: "帳號", value: "123-456" }],
      note: "備註",
    });
    expect((await row("MT1"))?.status).toBe("pending");
  });

  it("instructions 回錯誤(not_configured)→ 原樣透傳且不寫列", async () => {
    state.instructions = { ok: false, error: "not_configured" };
    const provider = makeProvider(makeServices());
    const session = await provider.createCheckout({
      orderNo: "MT2",
      amount: 500,
      description: "測試",
    });
    expect(session).toEqual({ ok: false, error: "not_configured" });
    expect(await row("MT2")).toBeNull();
  });

  it("非法表名 → throw(sql.raw 注入面)", () => {
    expect(() =>
      createManualPaymentProvider({
        services: makeServices(),
        providerId: "x",
        table: "bad-table;drop",
        instructions: async () => state.instructions,
      }),
    ).toThrow(/invalid orders table name/);
  });
});

describe("settleManual(統一結算)", () => {
  it("核可 → paid + payment:succeeded(帶 orderNo);重複核可冪等不重發 hook", async () => {
    const provider = makeProvider(makeServices());
    await provider.createCheckout({ orderNo: "MT3", amount: 100, description: "x" });

    const first = await provider.settleManual("MT3", true, "核可 by admin");
    expect(first).toEqual({ settled: true, known: true });
    const r = await row("MT3");
    expect(r?.status).toBe("paid");
    expect(r?.payment_type).toBe("MANUAL");
    expect(r?.raw_result).toBe("核可 by admin");
    expect(state.hookEvents).toHaveLength(1);
    expect(state.hookEvents[0]).toMatchObject({
      providerId: "manualtest",
      orderNo: "MT3",
    });

    const second = await provider.settleManual("MT3", true);
    expect(second).toEqual({ settled: false, known: true });
    expect(state.hookEvents).toHaveLength(1);
  });

  it("退回 → failed 不觸發 hook;之後仍可核可(failed → paid)", async () => {
    const provider = makeProvider(makeServices());
    await provider.createCheckout({ orderNo: "MT4", amount: 100, description: "x" });

    const rejected = await provider.settleManual("MT4", false, "對不到");
    expect(rejected).toEqual({ settled: true, known: true });
    expect((await row("MT4"))?.status).toBe("failed");
    expect(state.hookEvents).toHaveLength(0);

    const approved = await provider.settleManual("MT4", true);
    expect(approved).toEqual({ settled: true, known: true });
    expect((await row("MT4"))?.status).toBe("paid");
    expect(state.hookEvents).toHaveLength(1);
  });

  it("查無此單 → settled:false, known:false,不觸發 hook", async () => {
    const provider = makeProvider(makeServices());
    const outcome = await provider.settleManual("NOPE", true);
    expect(outcome).toEqual({ settled: false, known: false });
    expect(state.hookEvents).toHaveLength(0);
  });
});
