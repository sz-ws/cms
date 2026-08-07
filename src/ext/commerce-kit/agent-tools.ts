import { z } from "zod";
import { defineAgentTool, readStringArg } from "../agent-tools";
import type { AgentTool, AgentToolCtx } from "../agent-tools";
import type { Locale } from "@/lib/i18n/index";
import { makeScopedSettings } from "../settings-env";
import type { ApiCtx } from "../types";
import { getOrder, listOrders } from "./orders";
import { createOrderStatusHandler, createTransferVerifyHandler } from "./transfer";
import { ORDER_STATUSES, type CommerceOrder, type OrderStatus } from "./types";

// commerce-kit:訂單的 admin agent tools(docs/spec-admin-agent.md §2 表格第二列的
// 實證 —— 裝了 shop,AI 就會操作訂單,core 一行都不必改)。
//
// 分工照 kit 的既有慣例:工廠住 kit(訂單語意、狀態機、核可路徑都在這裡),
// extension 只接線(表名、settings key、`agentTools:` 一行)。
//
// ── 兩個 write tool 為什麼是「呼叫既有 handler」而不是自己寫一段 ────────────────
// 訂單翻 paid 的路徑只有一條:settleManual → payment:succeeded → markOrderPaid(hook)
// (transfer.ts 檔頭,1.28.0 立下)。agent 若自己 transitionOrder(…, "paid"),就會出現
// 「訂單說收到錢了,但付款表裡沒有那筆錢」的狀態 —— 那正是這條紀律要防的事。
// 所以 verify/transition 直接呼叫 createTransferVerifyHandler /
// createOrderStatusHandler 產生的 handler 本體:不是複製一份邏輯,是**同一段程式**,
// 與 admin 對帳佇列按下的那個按鈕跑的完全一樣。
//
// 這也是 AgentToolCtx 的形狀當初刻意對齊 ApiCtx 的用處(agent-tools.ts 檔頭):
// { user, services } 兩個欄位一字不差,handler 直接吃得下。
//
// ── args 不承載任何 secret(spec §1.3 的 v1 契約)────────────────────────────
// 確認卡會把 args 原樣顯示給 admin,而 audit 表也原樣記下。所以這裡的 args 只有
// 訂單編號、狀態與一句附註 —— 收款帳號、金鑰、provider 憑證一律不經過 args
// (provider id 由 kit 自己讀 settings,見 resolveTransferProviderId)。

/** list 回傳的摘要列 —— 刻意不帶 lines/地址/信箱:那是 get 的事(同 content list 的分工)。 */
export interface CommerceOrderSummary {
  orderNo: string;
  status: OrderStatus;
  /** 應付總額(整數,最小貨幣單位)。 */
  total: number;
  /** 品項總件數(找單用;要看是哪些商品請走 get)。 */
  itemCount: number;
  customerName: string;
  paymentProvider: string;
  createdAt: number;
}

export interface CommerceAgentToolsOptions {
  /** 宣告這些 tool 的 extension id —— tool 名的前綴,defineExtension 會驗。 */
  extId: string;
  /** 訂單表名(同 kit 其他工廠)。 */
  table: string;
  /**
   * 匯款 provider id 的**完整** settings key。預設 `ext.<extId>.transferProvider`。
   *
   * 由 extension 傳同一個常數進來(extensions/shop 就是這樣做的),核帳 route 與
   * agent tool 讀的因此保證是同一個 key —— 分家的症狀會是「後台核得動、AI 核不動」,
   * 那是最難查的一種。
   */
  transferProviderKey?: string;
}

/** 訂單編號:結帳產生的是 `SO<base36>`,但允許自訂產生器用連字號/底線。 */
const orderNoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid order number");

/** 附註上限。kit handler 的 note 上限是 200,留出下方署名的餘裕。 */
const NOTE_MAX = 120;
const noteSchema = z.string().trim().min(1).max(NOTE_MAX);

/**
 * 寫進訂單 note 欄的署名。
 *
 * agent_audit 已經記了「誰、用哪個 tool、什麼參數」,但那是另一張表;訂單自己的
 * note 是**看訂單的人**唯一會讀到的軌跡,所以「這個動作是 AI 提議、由人核可的」
 * 要寫在這裡。handler 另外會補上 admin 的 email,兩者合起來就是完整的責任鏈。
 */
const AGENT_STAMP = "(AI 助理提案,admin 確認)";
function stampNote(note: string | undefined): string {
  return note ? `${note} ${AGENT_STAMP}` : AGENT_STAMP;
}

// ── 確認卡摘要(1.31.0)────────────────────────────────────────────────────────
// 這兩句是站方按下「確認執行」之前唯一讀到的字,而按下去等於「宣稱收到了錢」或
// 「宣稱貨出了」。所以摘要一定要指名**哪一張單**;args 是模型未驗證的原始 input
// (見 AgentTool.summarize),缺編號時寧可明說缺,也不要生出一句看起來很篤定的話。

/** 缺 orderNo 時給一個看得出「這裡是空的」的佔位字,而不是空白。 */
function summaryOrderNo(args: unknown, locale: Locale): string {
  const orderNo = readStringArg(args, "orderNo");
  if (orderNo) return orderNo;
  return locale === "zh-Hant" ? "(未指定編號)" : "(no order number)";
}

/** 狀態的中文說法。訂單頁與對帳佇列用的是同一組詞,摘要不另創一套。 */
const STATUS_ZH: Record<string, string> = {
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
};

function toSummary(order: CommerceOrder): CommerceOrderSummary {
  return {
    orderNo: order.orderNo,
    status: order.status,
    total: order.amounts.total,
    itemCount: order.lines.reduce((n, line) => n + line.qty, 0),
    customerName: order.customerName,
    paymentProvider: order.paymentProvider,
    createdAt: order.createdAt,
  };
}

/** AgentToolCtx → ApiCtx。兩個形狀一字不差,故不需要任何轉換(見檔頭)。 */
function toApiCtx(ctx: AgentToolCtx): ApiCtx {
  return { user: ctx.user, services: ctx.services };
}

/** kit handler 只讀 req.json(),所以合成一個最小的 POST 就夠。 */
function jsonRequest(body: unknown): Request {
  return new Request("https://agent.local/commerce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface HandlerBody {
  ok?: boolean;
  error?: string;
  status?: string;
}

/**
 * 跑 kit handler 並把失敗轉成 throw。
 *
 * 為什麼 throw 而不是把 { ok:false } 原樣回傳:invokeAgentTool 只有在 throw 時才會
 * 記成失敗的 audit 列,而一個「回了物件所以算成功」的失敗,會讓確認卡顯示「已執行」
 * 卻什麼都沒發生 —— 對確認制而言那是最糟的一種回報(同 dx/agent-tools.ts 的 delete
 * 對 not_found 的態度)。
 */
async function runHandler(
  handler: (
    req: Request,
    params: Record<string, string>,
    ctx: ApiCtx,
  ) => Promise<Response>,
  ctx: AgentToolCtx,
  orderNo: string,
  body: unknown,
): Promise<{ orderNo: string; status?: string }> {
  const res = await handler(jsonRequest(body), { orderNo }, toApiCtx(ctx));
  const parsed = (await res.json()) as HandlerBody;
  if (!res.ok || parsed.ok === false) {
    const where = parsed.status ? ` (order is ${parsed.status})` : "";
    throw new Error(`${parsed.error ?? "failed"}${where}`);
  }
  return { orderNo, status: parsed.status };
}

/**
 * 訂單的 agent tools。extension 以 `agentTools: createCommerceAgentTools({…})` 接線。
 *
 * 最小集,刻意不長:list/get 讓 agent 找得到單並讀得懂,verify/transition 是站方
 * 實際會做的兩個動作。退款、改金額、改地址不在內 —— 那些要嘛涉及 gateway
 * (spec-payment-capability.md §6 明定不做),要嘛應該由人在訂單頁上做。
 */
export function createCommerceAgentTools(
  opts: CommerceAgentToolsOptions,
): AgentTool[] {
  const { extId, table } = opts;
  const transferProviderKey =
    opts.transferProviderKey ?? `ext.${extId}.transferProvider`;

  // ctx.services 是 **core-scoped** 的(agent 端點一律 createServices("core")),
  // 所以 ctx.services.settings.get("ext.shop.…") 會因越界而 throw。這裡自建一份
  // scope 綁在本 extension 的 ScopedSettings —— 與 extension 自己的 API handler 讀的
  // 是同一支實作(env 覆寫 → D1,1.27.0),不是另一條讀法。
  const settings = makeScopedSettings(extId);
  const resolveTransferProviderId = async (): Promise<string> =>
    (await settings.get<string>(transferProviderKey, "")).trim();

  const verifyHandler = createTransferVerifyHandler({
    table,
    resolveTransferProvider: resolveTransferProviderId,
  });
  const statusHandler = createOrderStatusHandler({ table });

  return [
    defineAgentTool({
      name: `${extId}.orders.list`,
      description:
        "List shop orders, newest first. " +
        "Returns one summary row per order (order number, status, total, item count, customer name, payment provider, created time) — " +
        `not the line items, use ${extId}.orders.get for one order in full. ` +
        "Filter by status to work a queue: awaiting_verify is waiting for someone to check the bank account, " +
        "paid means the money arrived and the order still needs shipping.",
      kind: "read",
      schema: z
        .object({
          status: z.enum(ORDER_STATUSES).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
      run: async (ctx, args) => {
        const orders = await listOrders(ctx.services, table, {
          ...(args.status ? { status: args.status } : {}),
          limit: args.limit ?? 20,
        });
        return { items: orders.map(toSummary), count: orders.length };
      },
    }),

    defineAgentTool({
      name: `${extId}.orders.get`,
      description:
        "Read one shop order in full by its order number. " +
        "Includes the line items, the amount breakdown, the customer's contact and delivery details, " +
        "the reported bank-transfer digits, and the note trail that every status change appends — " +
        "read the notes before acting, they say who did what and when. " +
        "Returns null when there is no such order.",
      kind: "read",
      schema: z.object({ orderNo: orderNoSchema }).strict(),
      run: async (ctx, args) => getOrder(ctx.services, table, args.orderNo),
    }),

    defineAgentTool({
      name: `${extId}.orders.verify`,
      description:
        "Mark a bank-transfer order as paid after checking the bank account. " +
        "Only do this once the money is confirmed to have arrived — what the customer reported is a hint, not proof, " +
        "so read the order first and say which order and which amount you are approving. " +
        "This runs exactly what the admin verification queue runs: the payment is settled first and the order flips to " +
        "paid through the payment hook, so a transfer order ends up identical to a card order. " +
        "Orders still in pending_payment can be approved too (a customer may pay without ever reporting it).",
      kind: "write",
      schema: z
        .object({ orderNo: orderNoSchema, note: noteSchema.optional() })
        .strict(),
      summarize: (args, locale) => {
        const orderNo = summaryOrderNo(args, locale);
        return locale === "zh-Hant"
          ? `把訂單 ${orderNo} 標記為已收款(手動核帳)`
          : `Mark order ${orderNo} as paid (manual verification)`;
      },
      run: async (ctx, args) =>
        runHandler(verifyHandler, ctx, args.orderNo, {
          approve: true,
          note: stampNote(args.note),
        }),
    }),

    defineAgentTool({
      name: `${extId}.orders.transition`,
      description:
        "Move a shop order to shipped, completed, cancelled or refunded. " +
        "The order state machine decides what is legal: paid → shipped → completed, cancelled only while the money " +
        "has not arrived yet, and refunded only from paid; anything else fails with illegal_transition. " +
        "Refunded is bookkeeping only — it records a refund the shop already made in its bank or payment dashboard, " +
        "it does not move any money. " +
        `Marking an order paid is not done here — that is ${extId}.orders.verify.`,
      kind: "write",
      schema: z
        .object({
          orderNo: orderNoSchema,
          to: z.enum(["shipped", "completed", "cancelled", "refunded"]),
          note: noteSchema.optional(),
        })
        .strict(),
      summarize: (args, locale) => {
        const orderNo = summaryOrderNo(args, locale);
        const to = readStringArg(args, "to");
        if (locale === "zh-Hant") {
          // 認不得的 to 就原樣寫出來(而不是猜):模型送了什麼,admin 就看到什麼。
          const label = STATUS_ZH[to] ?? to;
          return label
            ? `把訂單 ${orderNo} 轉為${label}`
            : `把訂單 ${orderNo} 轉為新狀態`;
        }
        return to
          ? `Move order ${orderNo} to ${to}`
          : `Move order ${orderNo} to a new status`;
      },
      run: async (ctx, args) =>
        runHandler(statusHandler, ctx, args.orderNo, {
          to: args.to,
          note: stampNote(args.note),
        }),
    }),
  ];
}
