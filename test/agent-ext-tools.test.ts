import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { z } from "zod";

// docs/spec-admin-agent.md Phase E:code extension 的 `agentTools` 欄位 +
// commerce-kit 宣告的訂單 tools —— 「裝一個 extension = AI 自動會操作它」的實證。
//
// 三段:
//   1. defineExtension 的驗證(命名空間 / 重複 / kind / 版號閘)—— 壞宣告在載入期就炸。
//   2. buildAgentToolRegistry 的第三個來源(enabled code extensions),且不影響
//      另外兩個來源。
//   3. commerce tools 對真 D1:list/get 的形狀,verify 走的是**與 admin 對帳佇列
//      同一條**核可路徑(settleManual → hook 翻單),transition 吃狀態機。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock(同 agent-tools.test.ts):真實 loader 經 interpret.tsx →
// next/navigation,workers pool 靜態解析會炸。這裡的 mock 同時是測試裝置 ——
// 「哪些 code extension 是 enabled」就是第三個註冊來源的輸入。
const runtimeState = vi.hoisted(() => ({
  enabled: [] as unknown[],
  all: [] as unknown[],
}));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  return {
    getExtRuntime: async () => ({
      enabled: runtimeState.enabled,
      all: runtimeState.all,
      hooks: new HookBus(),
      byId: () => undefined,
      isCompatible: () => true,
      unavailableById: new Map(),
    }),
  };
});

import { db } from "../src/lib/db";
import { HookBus } from "../src/ext/hooks";
import { defineAgentTool, invokeAgentTool } from "../src/ext/agent-tools";
import type { AgentTool, AgentToolCtx } from "../src/ext/agent-tools";
import { buildAgentToolRegistry } from "../src/ext/agent-tools-runtime";
import { defineExtension } from "../src/ext/types";
import type { Extension } from "../src/ext/types";
import { createCommerceAgentTools } from "../src/ext/commerce-kit/agent-tools";
import type { CommerceOrderSummary } from "../src/ext/commerce-kit/agent-tools";
import { createOrder, getOrder, markOrderPaid } from "../src/ext/commerce-kit/orders";
import { createManualPaymentProvider } from "../src/ext/payment-kit/manual";
import type { CommerceOrder } from "../src/ext/commerce-kit/types";
import type { CoreServices } from "../src/ext/services";
import { invalidateSettingsCache, setSettings } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const EXT_ID = "shoptest";
const ORDERS_TABLE = "ext_shoptest_orders";
const PAY_TABLE = "ext_shoptestpay_orders";

// ---------------------------------------------------------------- fixtures

/** 合法的 tool(走 defineAgentTool,與真實 extension 作者的寫法相同)。 */
function tool(name: string, kind: "read" | "write" = "read"): AgentTool {
  return defineAgentTool({
    name,
    description: `Do ${name} for the tests.`,
    kind,
    schema: z.object({}).strict(),
    run: async () => ({ ok: true }),
  });
}

/** 繞過 defineAgentTool 的手寫物件 —— 驗證不能只靠工廠函式(registry 前例)。 */
function rawTool(over: Record<string, unknown>): AgentTool {
  return {
    name: "demo.things.list",
    description: "List things.",
    kind: "read",
    schema: z.object({}).strict(),
    execute: async () => null,
    ...over,
  } as AgentTool;
}

function manifest(over: Partial<Extension>): Extension {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    coreApi: "^1.30.0",
    ...over,
  } as Extension;
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);",
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${ORDERS_TABLE} (order_no TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending_payment', lines TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, shipping INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, payment_provider TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT, ship_address TEXT, region TEXT, shipping_method TEXT, promo_code TEXT, transfer_last5 TEXT, transfer_reported_at INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  await d1().exec(
    `CREATE TABLE IF NOT EXISTS ${PAY_TABLE} (order_no TEXT PRIMARY KEY, amount INTEGER NOT NULL, description TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', trade_no TEXT, payment_type TEXT, pay_time TEXT, raw_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec(`DELETE FROM ${ORDERS_TABLE};`);
  await d1().exec(`DELETE FROM ${PAY_TABLE};`);
  invalidateSettingsCache();
  runtimeState.enabled = [];
  runtimeState.all = [];
});

// ------------------------------------------------- 1. defineExtension 驗證

describe("defineExtension:agentTools 的命名空間與形狀(1.30.0)", () => {
  it("合法宣告原樣通過,欄位保留", () => {
    const ext = defineExtension(
      manifest({ agentTools: [tool("demo.things.list"), tool("demo.things.delete", "write")] }),
    );
    expect(ext.agentTools?.map((t) => `${t.name} ${t.kind}`)).toEqual([
      "demo.things.list read",
      "demo.things.delete write",
    ]);
  });

  it("沒宣告 agentTools 的既有 extension 完全不受影響(舊 coreApi 也照樣過)", () => {
    expect(() => defineExtension(manifest({ coreApi: "^1.0.0" }))).not.toThrow();
  });

  it("名字沒有 `<extId>.` 前綴 → 拒(含冒用別人命名空間的情況)", () => {
    expect(() =>
      defineExtension(manifest({ agentTools: [tool("orders.list")] })),
    ).toThrow(/must start with "demo\."/);
    // 冒名:一個 extension 宣告另一個 extension 的動作 —— 前綴規則存在的理由。
    expect(() =>
      defineExtension(manifest({ agentTools: [tool("shop.orders.verify", "write")] })),
    ).toThrow(/must start with "demo\."/);
  });

  it("名字形狀不合(單段、大寫、空段)→ 拒", () => {
    for (const bad of ["demo", "Demo.Things.List", "demo..list"]) {
      expect(() =>
        defineExtension(manifest({ agentTools: [rawTool({ name: bad })] })),
        bad,
      ).toThrow(/invalid tool name/);
    }
  });

  it("同一個 extension 內重複 name → 拒(不是後蓋前)", () => {
    expect(() =>
      defineExtension(
        manifest({ agentTools: [tool("demo.things.list"), tool("demo.things.list")] }),
      ),
    ).toThrow(/duplicate tool name "demo\.things\.list"/);
  });

  it("kind 不是 read/write → 拒(kind 是確認制的載體,不是分類標籤)", () => {
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ kind: "admin" })] })),
    ).toThrow(/kind/);
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ kind: undefined })] })),
    ).toThrow(/kind/);
  });

  it("description 空白 → 拒(對 LLM 而言等於這個 tool 不存在)", () => {
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ description: "   " })] })),
    ).toThrow(/description/);
  });

  it("summarize 不是 function → 拒(1.31.0:選填,但寫了就要是函式)", () => {
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ summarize: "一句話" })] })),
    ).toThrow(/agentTools/);
    // 省略仍然合法 —— 沒有 summarize 的 tool 退回推導版摘要。
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({})] })),
    ).not.toThrow();
  });

  it("execute 不是 function / schema 不是 zod → 拒", () => {
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ execute: "nope" })] })),
    ).toThrow(/agentTools/);
    expect(() =>
      defineExtension(manifest({ agentTools: [rawTool({ schema: { type: "object" } })] })),
    ).toThrow(/zod schema/);
  });

  it("宣告 agentTools 卻沒標 coreApi ^1.30.0 → 拒(舊 core 會安靜忽略這個欄位)", () => {
    expect(() =>
      defineExtension(
        manifest({ coreApi: "^1.29.0", agentTools: [tool("demo.things.list")] }),
      ),
    ).toThrow(/agentTools requires coreApi/);
    expect(() =>
      defineExtension(
        manifest({ coreApi: ">=1.30.0", agentTools: [tool("demo.things.list")] }),
      ),
    ).not.toThrow();
  });
});

// ------------------------------------------------ 2. registry 的第三個來源

describe("buildAgentToolRegistry:enabled code extensions(spec §2 表格第二列)", () => {
  const DX_MANIFEST = {
    kind: "declarative",
    id: "gallery",
    name: "Gallery",
    version: "1.0.0",
    coreApi: "^1.28.0",
    contentTypes: [{ name: "item", fields: [{ key: "title", type: "text" }] }],
  };

  async function seedDeclarative(): Promise<void> {
    await d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?,?,?,?)",
      )
      .bind("gallery", "1.0.0", JSON.stringify(DX_MANIFEST), 1)
      .run();
  }

  it("code extension 宣告的 tools 進得了 registry,kind 一路保留", async () => {
    runtimeState.enabled = [
      defineExtension(
        manifest({ agentTools: [tool("demo.things.list"), tool("demo.things.delete", "write")] }),
      ),
    ];

    const registry = await buildAgentToolRegistry();
    expect(registry.get("demo.things.list")?.kind).toBe("read");
    expect(registry.get("demo.things.delete")?.kind).toBe("write");
    expect(registry.list("write").map((t) => t.name)).toContain("demo.things.delete");
  });

  it("另外兩個來源不受影響,三者共存且無撞名", async () => {
    await seedDeclarative();
    runtimeState.enabled = [
      defineExtension(manifest({ agentTools: [tool("demo.things.list")] })),
    ];

    const names = (await buildAgentToolRegistry()).names();
    expect(names).toContain("core.settings.get"); // core 內建
    expect(names).toContain("content.gallery_item.list"); // declarative 自動生成
    expect(names).toContain("demo.things.list"); // code extension
    expect(new Set(names).size).toBe(names.length);
  });

  it("沒宣告 agentTools 的 enabled extension 什麼都不貢獻", async () => {
    runtimeState.enabled = [defineExtension(manifest({ coreApi: "^1.0.0" }))];
    const names = (await buildAgentToolRegistry()).names();
    expect(names.every((n) => n.startsWith("core."))).toBe(true);
  });

  it("繞過 defineExtension 的壞宣告 → 組 registry 時 throw(code 是程式碼,不是資料)", async () => {
    // 手寫 JS / any 繞過 defineExtension 的情況:規則在 runtime 再驗一次。
    runtimeState.enabled = [
      manifest({ agentTools: [rawTool({ name: "shop.orders.verify", kind: "write" })] }),
    ];
    await expect(buildAgentToolRegistry()).rejects.toThrow(
      /extension "demo" declares invalid agentTools/,
    );
  });
});

// ------------------------------------------------- 3. commerce 訂單 tools

describe("commerce-kit 訂單 tools(裝了 shop,AI 就會操作訂單)", () => {
  const LINES = [
    { productId: "p1", name: "商品一", unitPrice: 300, qty: 2 },
    { productId: "p2", name: "商品二", unitPrice: 100, qty: 1 },
  ];
  const AMOUNTS = { subtotal: 700, discount: 0, shipping: 60, total: 760 };

  let services: CoreServices;
  let hookEvents: unknown[];
  let tools: AgentTool[];

  function byName(name: string): AgentTool {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  function ctx(): AgentToolCtx {
    return {
      user: {
        id: "u1",
        email: "admin@test.com",
        name: "Admin",
        role: "admin",
        avatarKey: null,
      },
      services,
    } as AgentToolCtx;
  }

  /** 建訂單(+ 可選:付款列,匯款 checkout 當下就會產生的那一列)。 */
  async function seedOrder(
    orderNo: string,
    status = "pending_payment",
    withPaymentRow = true,
  ): Promise<void> {
    await createOrder({ db: db() }, ORDERS_TABLE, {
      orderNo,
      lines: LINES,
      amounts: AMOUNTS,
      paymentProvider: "manualtest",
      customerName: "王小明",
      customerEmail: "ming@example.com",
      shipAddress: "台北市…",
    });
    if (status !== "pending_payment") {
      await d1()
        .prepare(`UPDATE ${ORDERS_TABLE} SET status = ? WHERE order_no = ?`)
        .bind(status, orderNo)
        .run();
    }
    if (withPaymentRow) {
      const now = Date.now();
      await d1()
        .prepare(
          `INSERT INTO ${PAY_TABLE} (order_no, amount, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        )
        .bind(orderNo, AMOUNTS.total, "測試", "pending", now, now)
        .run();
    }
  }

  async function payRow(orderNo: string) {
    return d1()
      .prepare(
        `SELECT status, payment_type, raw_result FROM ${PAY_TABLE} WHERE order_no = ?`,
      )
      .bind(orderNo)
      .first<{ status: string; payment_type: string | null; raw_result: string | null }>();
  }

  beforeEach(async () => {
    hookEvents = [];
    const hooks = new HookBus();
    // 鏡射 extensions/shop 的接線:訂單翻 paid 的唯一路徑就是這個 hook。
    hooks.register("shoptest", "payment:succeeded", async (payload: unknown) => {
      hookEvents.push(payload);
      await markOrderPaid({ db: db() }, ORDERS_TABLE, payload);
    });
    const built = {
      db: db(),
      hooks,
      providers: {
        getById: (cap: string, id: string) =>
          cap === "payment" && id === "manualtest" ? manual : null,
      },
    } as unknown as CoreServices;
    const manual = createManualPaymentProvider({
      services: built,
      providerId: "manualtest",
      table: PAY_TABLE,
      instructions: async () => ({ ok: true, instructions: [] }),
    });
    services = built;
    tools = createCommerceAgentTools({ extId: EXT_ID, table: ORDERS_TABLE });
    // 匯款 provider id 走 settings,與 extension 自己的核帳 route 讀同一個 key。
    await setSettings({ [`ext.${EXT_ID}.transferProvider`]: "manualtest" });
  });

  it("四個 tool,名字帶 extension 前綴,write 標對(確認制的前提)", () => {
    expect(tools.map((t) => `${t.name} ${t.kind}`)).toEqual([
      "shoptest.orders.list read",
      "shoptest.orders.get read",
      "shoptest.orders.verify write",
      "shoptest.orders.transition write",
    ]);
  });

  it("description 第一句是完整人話(確認卡摘要與斜線選單副標的來源)", () => {
    expect(byName("shoptest.orders.verify").description.split(". ")[0]).toBe(
      "Mark a bank-transfer order as paid after checking the bank account",
    );
    for (const t of tools) {
      expect(t.description.split(". ")[0].length, t.name).toBeGreaterThan(20);
    }
  });

  it("list:摘要列(金額/狀態/客名),不回 lines;status filter 與 limit 生效", async () => {
    await seedOrder("SO1");
    await seedOrder("SO2", "paid");
    await seedOrder("SO3", "paid");

    const all = await invokeAgentTool(byName("shoptest.orders.list"), ctx(), {});
    expect(all.ok).toBe(true);
    const items =
      all.ok === true ? (all.result as { items: CommerceOrderSummary[] }).items : [];
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      orderNo: expect.any(String),
      status: expect.any(String),
      total: 760,
      itemCount: 3,
      customerName: "王小明",
      paymentProvider: "manualtest",
      createdAt: expect.any(Number),
    });
    // 摘要不得挾帶整份品項/聯絡資料 —— 那是 get 的事(脈絡預算)。
    expect(JSON.stringify(items)).not.toContain("商品一");
    expect(JSON.stringify(items)).not.toContain("ming@example.com");

    const paid = await invokeAgentTool(byName("shoptest.orders.list"), ctx(), {
      status: "paid",
    });
    expect(
      paid.ok === true
        ? (paid.result as { items: CommerceOrderSummary[] }).items.map((o) => o.orderNo).sort()
        : [],
    ).toEqual(["SO2", "SO3"]);

    const one = await invokeAgentTool(byName("shoptest.orders.list"), ctx(), { limit: 1 });
    expect(one.ok === true && (one.result as { count: number }).count).toBe(1);

    // 未知狀態 / 多帶欄位一律退回(hallucinated 參數不會被吞掉)。
    expect(
      await invokeAgentTool(byName("shoptest.orders.list"), ctx(), { status: "done" }),
    ).toMatchObject({ ok: false, error: "invalid_args" });
    expect(
      await invokeAgentTool(byName("shoptest.orders.list"), ctx(), { bogus: 1 }),
    ).toMatchObject({ ok: false, error: "invalid_args" });
  });

  it("get:整筆訂單(含 note 審計軌跡);查無此單 → null;壞編號 → invalid_args", async () => {
    await seedOrder("SO4", "awaiting_verify");
    await d1()
      .prepare(`UPDATE ${ORDERS_TABLE} SET note = ?, transfer_last5 = ? WHERE order_no = ?`)
      .bind("客人回報 12345", "12345", "SO4")
      .run();

    const res = await invokeAgentTool(byName("shoptest.orders.get"), ctx(), {
      orderNo: "SO4",
    });
    expect(res.ok).toBe(true);
    const order = res.ok === true ? (res.result as CommerceOrder) : null;
    expect(order).toMatchObject({
      orderNo: "SO4",
      status: "awaiting_verify",
      lines: LINES,
      amounts: AMOUNTS,
      customerEmail: "ming@example.com",
      transferLast5: "12345",
      note: "客人回報 12345",
    });

    expect(
      await invokeAgentTool(byName("shoptest.orders.get"), ctx(), { orderNo: "GHOST" }),
    ).toEqual({ ok: true, result: null });
    expect(
      await invokeAgentTool(byName("shoptest.orders.get"), ctx(), { orderNo: "SO 4;" }),
    ).toMatchObject({ ok: false, error: "invalid_args" });
  });

  it("verify:走 settleManual → payment:succeeded → hook 翻單(與對帳佇列同一條路)", async () => {
    await seedOrder("SO5", "awaiting_verify");

    const res = await invokeAgentTool(byName("shoptest.orders.verify"), ctx(), {
      orderNo: "SO5",
      note: "對到 5/12 入帳 760",
    });
    expect(res).toEqual({ ok: true, result: { orderNo: "SO5", status: "paid" } });

    // 訂單翻 paid,而且是**經由付款結算**:付款列同時被結掉。
    expect((await getOrder({ db: db() }, ORDERS_TABLE, "SO5"))?.status).toBe("paid");
    const pay = await payRow("SO5");
    expect(pay?.status).toBe("paid");
    expect(pay?.payment_type).toBe("MANUAL");
    expect(pay?.raw_result).toContain("核可 by admin@test.com");
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toMatchObject({ providerId: "manualtest", orderNo: "SO5" });

    // 訂單自己的 note 軌跡留下「AI 提案、人核可」與 admin 身分。
    const note = (await getOrder({ db: db() }, ORDERS_TABLE, "SO5"))?.note ?? "";
    expect(note).toContain("AI 助理提案,admin 確認");
    expect(note).toContain("admin@test.com");
    expect(note).toContain("對到 5/12 入帳 760");
  });

  it("verify:pending_payment 也可核(台灣沒有 open banking,核可不以回報為前提)", async () => {
    await seedOrder("SO6");
    const res = await invokeAgentTool(byName("shoptest.orders.verify"), ctx(), {
      orderNo: "SO6",
    });
    expect(res.ok).toBe(true);
    expect((await getOrder({ db: db() }, ORDERS_TABLE, "SO6"))?.status).toBe("paid");
  });

  it("verify:沒有付款列就不翻單(沒有錢的紀錄 = 不能宣稱收到錢)", async () => {
    await seedOrder("SO7", "awaiting_verify", false);
    const res = await invokeAgentTool(byName("shoptest.orders.verify"), ctx(), {
      orderNo: "SO7",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/settle_failed/);
    expect((await getOrder({ db: db() }, ORDERS_TABLE, "SO7"))?.status).toBe(
      "awaiting_verify",
    );
    expect(hookEvents).toHaveLength(0);
  });

  it("verify:已完成的單 → illegal_state,狀態不動", async () => {
    await seedOrder("SO8", "completed");
    const res = await invokeAgentTool(byName("shoptest.orders.verify"), ctx(), {
      orderNo: "SO8",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/illegal_state \(order is completed\)/);
    expect((await getOrder({ db: db() }, ORDERS_TABLE, "SO8"))?.status).toBe("completed");
  });

  it("verify:provider 沒設定 → not_available(不是靜默成功)", async () => {
    await setSettings({ [`ext.${EXT_ID}.transferProvider`]: "" });
    await seedOrder("SO9", "awaiting_verify");
    const res = await invokeAgentTool(byName("shoptest.orders.verify"), ctx(), {
      orderNo: "SO9",
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/not_available/);
  });

  it("transition:合法轉移生效並留 note;非法轉移回明確錯誤", async () => {
    await seedOrder("SO10", "paid");
    const shipped = await invokeAgentTool(byName("shoptest.orders.transition"), ctx(), {
      orderNo: "SO10",
      to: "shipped",
      note: "黑貓 123",
    });
    expect(shipped).toEqual({ ok: true, result: { orderNo: "SO10", status: "shipped" } });
    const after = await getOrder({ db: db() }, ORDERS_TABLE, "SO10");
    expect(after?.status).toBe("shipped");
    expect(after?.note).toContain("黑貓 123");
    expect(after?.note).toContain("AI 助理提案,admin 確認");

    await seedOrder("SO11");
    const illegal = await invokeAgentTool(byName("shoptest.orders.transition"), ctx(), {
      orderNo: "SO11",
      to: "shipped",
    });
    expect(illegal.ok).toBe(false);
    expect(illegal.ok === false && illegal.error).toMatch(/illegal_transition/);
    expect((await getOrder({ db: db() }, ORDERS_TABLE, "SO11"))?.status).toBe(
      "pending_payment",
    );

    // paid 不從這裡走(那條路只有 verify)。
    expect(
      await invokeAgentTool(byName("shoptest.orders.transition"), ctx(), {
        orderNo: "SO11",
        to: "paid",
      }),
    ).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

// ------------------------------------------------- 4. 訂單 tools 的確認卡摘要

// 1.31.0:按下這兩張確認卡等於「宣稱收到了錢」與「宣稱貨出了」,所以摘要必須指名
// 哪一張單。args 是模型未經 schema 驗證的原始 input(write 永不在 loop 內執行),
// 缺欄位一律要能生出一句合理的話,絕不 throw。
describe("summarize:訂單 write tools(1.31.0)", () => {
  const tools = createCommerceAgentTools({ extId: EXT_ID, table: ORDERS_TABLE });
  const say = (name: string, args: unknown, locale: "en" | "zh-Hant"): string => {
    const tool = tools.find((t) => t.name === name)!;
    return tool.summarize!(args, locale);
  };

  it("read tool 沒有摘要 —— 它不會產生確認卡", () => {
    expect(tools.find((t) => t.name === `${EXT_ID}.orders.list`)!.summarize).toBeUndefined();
    expect(tools.find((t) => t.name === `${EXT_ID}.orders.get`)!.summarize).toBeUndefined();
  });

  it("verify:兩種語言都指名訂單編號,並說明這是手動核帳", () => {
    expect(say(`${EXT_ID}.orders.verify`, { orderNo: "SO42" }, "zh-Hant")).toBe(
      "把訂單 SO42 標記為已收款(手動核帳)",
    );
    expect(say(`${EXT_ID}.orders.verify`, { orderNo: "SO42" }, "en")).toBe(
      "Mark order SO42 as paid (manual verification)",
    );
  });

  it("transition:狀態說中文,用的是訂單頁那組詞", () => {
    for (const [to, zh] of [
      ["shipped", "已出貨"],
      ["completed", "已完成"],
      ["cancelled", "已取消"],
    ] as const) {
      expect(say(`${EXT_ID}.orders.transition`, { orderNo: "SO7", to }, "zh-Hant")).toBe(
        `把訂單 SO7 轉為${zh}`,
      );
      expect(say(`${EXT_ID}.orders.transition`, { orderNo: "SO7", to }, "en")).toBe(
        `Move order SO7 to ${to}`,
      );
    }
  });

  it("認不得的 to 原樣寫出來,不猜(模型送了什麼,admin 就看到什麼)", () => {
    expect(
      say(`${EXT_ID}.orders.transition`, { orderNo: "SO7", to: "refunded" }, "zh-Hant"),
    ).toBe("把訂單 SO7 轉為refunded");
  });

  it("缺 orderNo → 明說缺,而不是生出一句看起來很篤定的話", () => {
    expect(say(`${EXT_ID}.orders.verify`, {}, "zh-Hant")).toContain("(未指定編號)");
    expect(say(`${EXT_ID}.orders.verify`, {}, "en")).toContain("(no order number)");
    expect(say(`${EXT_ID}.orders.transition`, { to: "shipped" }, "zh-Hant")).toBe(
      "把訂單 (未指定編號) 轉為已出貨",
    );
  });

  it("餵任何垃圾都不 throw,且一定生得出非空字串", () => {
    for (const args of [undefined, null, "SO1", 42, [], {}, { orderNo: 1, to: 2 }]) {
      for (const name of [`${EXT_ID}.orders.verify`, `${EXT_ID}.orders.transition`]) {
        for (const locale of ["zh-Hant", "en"] as const) {
          expect(
            say(name, args, locale).trim().length,
            `${name} ${JSON.stringify(args)}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
