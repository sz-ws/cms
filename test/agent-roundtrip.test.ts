import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// docs/spec-admin-agent.md §4:code extension 的 write 提案走完 /chat → /execute 的
// 完整鏈,對真 D1。
//
// 與既有兩檔的分工:
//   * test/agent-loop.test.ts —— 假 registry,測 loop 的規則本身。
//   * test/agent-routes.test.ts —— 真 registry,但 write 是**自動生成**的 content CRUD。
//   * 本檔 —— write 來自 code extension(commerce-kit 的訂單核帳),而且那個動作背後
//     還有一整條 settleManual → payment:succeeded → hook 的路徑。所以「提案階段什麼
//     都沒發生」在這裡不是「contents 表少一列」,而是**錢的狀態沒有被動過**:訂單還在
//     awaiting_verify、付款列還是 pending、稽核表裡沒有任何 write。
//
// 這條鏈是整個確認制唯一會被真正用到的形狀:LLM 提案 → 人看確認卡 → 按下去才執行。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
  getAI: () => undefined,
}));

// requireAuth 由測試控制(pool-workers 無 request-scoped cookies),同 agent-routes。
const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    role: "admin" | "editor" | "guest";
    avatarKey: null;
  },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  const rank = { admin: 3, editor: 2, guest: 1 } as const;
  return {
    ...actual,
    requireAuth: async (role: "admin" | "editor" | "guest" = "editor") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (rank[authState.user.role] < rank[role]) throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// loader 全 mock(真實 loader 在 workers pool 載不起來:interpret → next/navigation)。
// 這裡的 runtime 同時是測試裝置:`enabled` 決定 registry 的第三個來源與 provider
// 註冊,`hooks` 是訂單翻 paid 的唯一路徑 —— 鏡射 extensions/shop 的接線。
const runtimeState = vi.hoisted(() => ({
  enabled: [] as unknown[],
  hookEvents: [] as unknown[],
}));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { markOrderPaid } = await import("../src/ext/commerce-kit/orders");
  const { db } = await import("../src/lib/db");
  const hooks = new HookBus();
  // 表名寫成字面值:vi.mock 的 factory 會被提升,引用不到模組頂層的 const。
  hooks.register("shop", "payment:succeeded", async (payload: unknown) => {
    runtimeState.hookEvents.push(payload);
    await markOrderPaid({ db: db() }, "ext_shop_orders", payload);
  });
  return {
    getExtRuntime: async () => ({
      enabled: runtimeState.enabled,
      all: runtimeState.enabled,
      hooks,
      byId: (id: string) =>
        (runtimeState.enabled as { id: string }[]).find((e) => e.id === id),
      isCompatible: () => true,
      unavailableById: new Map(),
    }),
  };
});

// 上游 LLM 由測試腳本控制(route 走 runAgentChat 的預設路徑 → dynamic import
// @/lib/ai,vi.mock 一樣生效)。
interface FakeChatResult {
  ok: boolean;
  text?: string;
  toolUses?: { id: string; name: string; input: unknown }[];
  stopReason?: string;
  error?: string;
}
const aiState = vi.hoisted(() => ({
  results: [] as FakeChatResult[],
  calls: [] as unknown[],
}));
vi.mock("@/lib/ai", () => ({
  chatAiWithTools: async (opts: unknown) => {
    aiState.calls.push(opts);
    return (
      aiState.results[aiState.calls.length - 1] ??
      aiState.results[aiState.results.length - 1] ?? {
        ok: true,
        text: "",
        toolUses: [],
        stopReason: "end_turn",
      }
    );
  },
}));

import { POST as chatPost } from "../src/app/api/admin/agent/chat/route";
import { POST as executePost } from "../src/app/api/admin/agent/execute/route";
import { db } from "../src/lib/db";
import { defineExtension } from "../src/ext/types";
import { createCommerceAgentTools } from "../src/ext/commerce-kit/agent-tools";
import { createOrder, getOrder } from "../src/ext/commerce-kit/orders";
import { createManualPaymentProvider } from "../src/ext/payment-kit/manual";
import type { CoreServices } from "../src/ext/services";
import { invalidateSettingsCache, setSettings } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ORIGIN = "https://cms.test";
const EXT_ID = "shop";
const ORDERS_TABLE = "ext_shop_orders";
const PAY_TABLE = "ext_shop_pay_orders";
const PROVIDER_ID = "banktransfer";
const ORDER_NO = "SOAGENT1";

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
  avatarKey: null,
};

const LINES = [{ productId: "p1", name: "商品一", unitPrice: 380, qty: 2 }];
const AMOUNTS = { subtotal: 760, discount: 0, shipping: 60, total: 820 };

/** 鏡射 extensions/shop:manual payment provider + 訂單 agent tools 的薄接線。 */
const SHOP = defineExtension({
  id: EXT_ID,
  name: "商店",
  version: "0.1.0",
  // ^1.31.0:agentTools(1.30.0)+ 確認卡摘要 summarize(1.31.0)。
  coreApi: "^1.31.0",
  provides: [
    {
      capability: "payment",
      id: PROVIDER_ID,
      create: (services: CoreServices) =>
        createManualPaymentProvider({
          services,
          providerId: PROVIDER_ID,
          table: PAY_TABLE,
          instructions: async () => ({ ok: true, instructions: [] }),
        }),
    },
  ],
  agentTools: createCommerceAgentTools({ extId: EXT_ID, table: ORDERS_TABLE }),
});

function req(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

const HELLO = [{ role: "user", content: [{ type: "text", text: "SOAGENT1 的錢到了嗎" }] }];

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT);",
  );
  // 1.34.0:agent loop 每一次上游呼叫都會寫一列用量(src/ext/ai-usage.ts)。
  // 它 fail-open,少了這張表不會讓測試失敗 —— 但會在每一輪對話留下一則
  // console.error,而那正好會蓋掉真正該被看見的錯誤。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, feature TEXT NOT NULL, mode TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, user_id TEXT NOT NULL, user_email TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);",
  );
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
  await d1().exec("DELETE FROM login_attempts;");
  await d1().exec("DELETE FROM agent_audit;");
  await d1().exec("DELETE FROM ai_usage;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec(`DELETE FROM ${ORDERS_TABLE};`);
  await d1().exec(`DELETE FROM ${PAY_TABLE};`);
  invalidateSettingsCache();
  authState.user = ADMIN;
  aiState.results = [];
  aiState.calls = [];
  runtimeState.enabled = [SHOP];
  runtimeState.hookEvents = [];
  await setSettings({
    // 核帳 tool 與 extension 自己的 route 讀同一個 key。
    [`ext.${EXT_ID}.transferProvider`]: PROVIDER_ID,
    // 摘要語言 —— 這是本檔存在的第二個理由:確認卡在繁中後台要是繁中。
    "core.locale": "zh-Hant",
  });
});

/** 客人已回報末五碼、等站方對帳的一張單(+ 匯款 checkout 當下產生的付款列)。 */
async function seedAwaitingVerify(): Promise<void> {
  await createOrder({ db: db() }, ORDERS_TABLE, {
    orderNo: ORDER_NO,
    lines: LINES,
    amounts: AMOUNTS,
    paymentProvider: PROVIDER_ID,
    customerName: "王小明",
    customerEmail: "ming@example.com",
    shipAddress: "台北市…",
  });
  await d1()
    .prepare(
      `UPDATE ${ORDERS_TABLE} SET status = 'awaiting_verify', transfer_last5 = '12345' WHERE order_no = ?`,
    )
    .bind(ORDER_NO)
    .run();
  const now = Date.now();
  await d1()
    .prepare(
      `INSERT INTO ${PAY_TABLE} (order_no, amount, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    )
    .bind(ORDER_NO, AMOUNTS.total, "匯款", "pending", now, now)
    .run();
}

async function orderStatus(): Promise<string | undefined> {
  return (await getOrder({ db: db() }, ORDERS_TABLE, ORDER_NO))?.status;
}

async function payStatus(): Promise<string | undefined> {
  const row = await d1()
    .prepare(`SELECT status FROM ${PAY_TABLE} WHERE order_no = ?`)
    .bind(ORDER_NO)
    .first<{ status: string }>();
  return row?.status;
}

async function auditRows(where = "1=1"): Promise<
  { tool: string; kind: string; source: string; ok: number; user_email: string }[]
> {
  const res = await d1()
    .prepare(`SELECT * FROM agent_audit WHERE ${where} ORDER BY at, tool`)
    .all<{
      tool: string;
      kind: string;
      source: string;
      ok: number;
      user_email: string;
    }>();
  return res.results;
}

interface ProposalBody {
  status: string;
  text: string;
  proposal: { toolName: string; toolUseId: string; args: unknown; summary: string };
}

describe("code extension 的 write 提案:/chat → 確認卡 → /execute(真 D1)", () => {
  it("走完整條鏈:提案時錢沒動,按下確認才翻單", async () => {
    await seedAwaitingVerify();
    const ARGS = { orderNo: ORDER_NO, note: "對到 5/12 入帳 820" };
    aiState.results = [
      {
        ok: true,
        text: "銀行那邊看起來收到了,我提一張核帳給你確認。",
        toolUses: [{ id: "tu-1", name: `${EXT_ID}.orders.verify`, input: ARGS }],
        stopReason: "tool_use",
      },
    ];

    // ── 1. /chat:回提案,而且**什麼都沒發生** ────────────────────────────
    const chatRes = await chatPost(req("/api/admin/agent/chat", { messages: HELLO }));
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as ProposalBody;

    expect(chatBody.status).toBe("proposal");
    expect(chatBody.proposal.toolName).toBe(`${EXT_ID}.orders.verify`);
    expect(chatBody.proposal.toolUseId).toBe("tu-1");
    expect(chatBody.proposal.args).toEqual(ARGS);
    expect(chatBody.proposal.summary.length).toBeGreaterThan(0);

    // 錢的狀態一動也沒動 —— 這比「contents 表沒有新列」更貼近這條路徑的風險。
    expect(await orderStatus()).toBe("awaiting_verify");
    expect(await payStatus()).toBe("pending");
    expect(runtimeState.hookEvents).toHaveLength(0);
    // 提案不是執行:稽核表裡沒有任何 write 列。
    expect(await auditRows("kind = 'write'")).toHaveLength(0);
    // 提案就結束,沒有續 loop。
    expect(aiState.calls).toHaveLength(1);

    // ── 2. /execute:提案原樣送回就會執行(前端不必改形狀)────────────────
    const execRes = await executePost(
      req("/api/admin/agent/execute", {
        toolName: chatBody.proposal.toolName,
        args: chatBody.proposal.args,
      }),
    );
    expect(execRes.status).toBe(200);
    expect(await execRes.json()).toEqual({
      ok: true,
      toolName: `${EXT_ID}.orders.verify`,
      result: { orderNo: ORDER_NO, status: "paid" },
    });

    // 訂單翻 paid,而且是**經由付款結算 + hook** —— 與 admin 對帳佇列按下的那顆
    // 按鈕跑的是同一段程式(1.28.0 立下的紀律,對 agent 一樣成立)。
    expect(await orderStatus()).toBe("paid");
    expect(await payStatus()).toBe("paid");
    expect(runtimeState.hookEvents).toHaveLength(1);
    expect(runtimeState.hookEvents[0]).toMatchObject({
      providerId: PROVIDER_ID,
      orderNo: ORDER_NO,
    });
    // 訂單自己的 note 留下「AI 提案、人核可」與是誰核的。
    const note = (await getOrder({ db: db() }, ORDERS_TABLE, ORDER_NO))?.note ?? "";
    expect(note).toContain("AI 助理提案,admin 確認");
    expect(note).toContain(ADMIN.email);

    // ── 3. 稽核:剛好一列 write,而且來自 /execute ────────────────────────
    const writes = await auditRows("kind = 'write'");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      tool: `${EXT_ID}.orders.verify`,
      kind: "write",
      source: "execute",
      ok: 1,
      user_email: ADMIN.email,
    });

    // ── 4. 不變量:write 永遠不會以 source='chat' 出現 ─────────────────────
    // 這一條是 spec §1.2 在稽核表上的投影 —— loop 內執行過 write,這裡就不是 0。
    expect(await auditRows("kind = 'write' AND source = 'chat'")).toHaveLength(0);
  });

  it("確認卡摘要是繁中且指名訂單(summarize 在真實鏈上生效,1.31.0)", async () => {
    await seedAwaitingVerify();
    aiState.results = [
      {
        ok: true,
        text: "",
        toolUses: [
          {
            id: "tu-1",
            name: `${EXT_ID}.orders.verify`,
            input: { orderNo: ORDER_NO },
          },
        ],
        stopReason: "tool_use",
      },
    ];

    const res = await chatPost(req("/api/admin/agent/chat", { messages: HELLO }));
    const body = (await res.json()) as ProposalBody;
    expect(body.status).toBe("proposal");
    // 「哪一張單」與「要做什麼」都在同一行 —— admin 只讀這一行就按下去。
    expect(body.proposal.summary).toContain("訂單");
    expect(body.proposal.summary).toContain(ORDER_NO);
    // 而且不是舊的推導版(英文的 description 第一句 + args JSON 預覽)。
    expect(body.proposal.summary).not.toContain("Mark a bank-transfer order");
    expect(body.proposal.summary).not.toContain('{"orderNo"');
  });

  it("轉移類的提案同樣不執行:狀態機沒被碰過", async () => {
    await seedAwaitingVerify();
    aiState.results = [
      {
        ok: true,
        text: "",
        toolUses: [
          {
            id: "tu-1",
            name: `${EXT_ID}.orders.transition`,
            input: { orderNo: ORDER_NO, to: "cancelled" },
          },
        ],
        stopReason: "tool_use",
      },
    ];

    const res = await chatPost(req("/api/admin/agent/chat", { messages: HELLO }));
    const body = (await res.json()) as ProposalBody;
    expect(body.proposal.toolName).toBe(`${EXT_ID}.orders.transition`);
    expect(body.proposal.summary).toBe(`把訂單 ${ORDER_NO} 轉為已取消`);
    expect(await orderStatus()).toBe("awaiting_verify");
    expect(await auditRows("kind = 'write'")).toHaveLength(0);
  });
});
