import { z } from "zod";
import { OrderManagedError, customerOrderManagedResponse, orderManagedResponse, resolveOrderOwner } from "./order-manager";
import { hitRateLimit } from "@/lib/rate-limit";
import { timingSafeEqualString } from "@/lib/security";
import { isManualPaymentProvider, transferReportSpec } from "../payment-kit/manual";
import { checkTransferReport, type TransferReportSpec } from "../payment-kit/report-spec";
import { reportedReference } from "./transfer-legacy";
import type { ApiCtx } from "../types";
import {
  getOrder,
  orderColumns,
  rewriteTransferReport,
  setOrderNote,
  transitionOrder,
} from "./orders";
import { isOrderStatus, type OrderStatus } from "./types";

// commerce-kit:匯款流程的三個 handler。
//   1. 回報(public):客人匯完款回報參考碼或匯款人姓名(要填什麼照收款的 manual provider 的
//      reportSpec(),預設帳號末五碼)→ pending_payment → awaiting_verify。
//   2. 核帳(admin):對到帳 → manual provider 的 settleManual(true) → 走統一結算
//      → payment:succeeded → markOrderPaid 把訂單翻 paid。**訂單翻 paid 的路徑只有
//      hook 這一條** —— 核帳 route 自己不改訂單狀態,刷卡與匯款因此完全同構。
//      對不到 → settleManual(false) 記帳 + 訂單退回 pending_payment(客人可補匯重報)。
//   3. 出貨/完成/取消(admin):純狀態機轉移。

const reportSchema = z
  .object({
    orderNo: z.string().regex(/^[A-Z0-9]{4,30}$/),
    /** 付款人回報的參考碼(格式照 reportSpec 檢查)。 */
    reference: z.string().max(60).optional(),
    /** 匯款人姓名。 */
    payerName: z.string().max(100).optional(),
    /**
     * 下單的 Email:證明回報的人是下單的人。core 自己的訂單,沒登入(或登入的不是這筆訂單的 Email、也不是
     * 管理員)就要帶;接管訂單的插件拿它認訪客。
     */
    email: z.string().max(200).optional(),
    /** @deprecated 1.63.0 — remove in 2.0. The old name of `reference`. */
    last5: z.string().max(60).optional(),
  })
  .strict();

type TransferProviderResolver = (ctx: ApiCtx) => Promise<string>;

/** 收款的 manual provider 要客人回報什麼;沒有 resolver 或 provider 就是預設(帳號末五碼)。 */
async function reportSpecFor(
  ctx: ApiCtx,
  resolve: TransferProviderResolver | undefined,
): Promise<TransferReportSpec> {
  const providerId = resolve ? await resolve(ctx) : "";
  const provider = providerId ? ctx.services.providers.getById<unknown>("payment", providerId) : null;
  return transferReportSpec(provider);
}

const sameEmail = (stored: string, given: string) =>
  // 固定時間比對;存的是空的也比一次(stored 換成一個不可能是 Email 的字),每種失敗走同一條路。
  timingSafeEqualString(stored.trim().toLowerCase() || "\u0000", given.trim().toLowerCase());

/**
 * core 自己的訂單:回報的人是不是下單的人。帶了下單的 Email(忽略大小寫與前後空白)就是;沒帶或不對時,
 * 登入的是管理員、或登入帳號的 Email 就是這筆訂單的,也算。和接管訂單的插件認訪客的方式一樣(訂單編號 + Email)。
 */
async function reporterOwns(customerEmail: string, email: string | undefined): Promise<boolean> {
  if (email !== undefined && sameEmail(customerEmail, email)) return true;
  const { getSessionUser, isFullAdmin } = await import("@/lib/auth");
  const user = await getSessionUser();
  if (!user) return false;
  return isFullAdmin(user) || sameEmail(customerEmail, user.email ?? "");
}

/** 公開匯款回報 handler(POST transfer-report,ApiRoute.public)。 */
export function createTransferReportHandler(opts: {
  table: string;
  /** 1.63.0:匯款 providerId 解析,用來讀它的 reportSpec()。沒給 = 預設的帳號末五碼。 */
  resolveTransferProvider?: TransferProviderResolver;
}) {
  return async function transferReportHandler(
    req: Request,
    _params: Record<string, string>,
    _ctx: ApiCtx,
  ): Promise<Response> {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (
      await hitRateLimit(ip, {
        namespace: "commerce-transfer-report",
        limit: 20,
        windowMs: 15 * 60 * 1000,
      })
    ) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    let body: z.infer<typeof reportSchema>;
    try {
      body = reportSchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }

    // 1.63.0:訂單管理插件的訂單交給它(它看登入的人或訪客的 Email、照它的規則檢查)。
    const owner = await resolveOrderOwner(_ctx.services, opts.table, body.orderNo);
    if (owner.kind === "managed" && owner.manager.reportTransfer) {
      return owner.manager.reportTransfer(
        { orderNo: body.orderNo, reference: reportedReference(body), payerName: body.payerName, email: body.email },
        req,
        _ctx,
      );
    }
    // 給客人看的回應:不寫接手的插件是誰、要誰去啟用它(那是後台的事)。
    if (owner.kind !== "core") return customerOrderManagedResponse();

    const spec = await reportSpecFor(_ctx, opts.resolveTransferProvider);
    const checked = checkTransferReport(spec, {
      reference: reportedReference(body),
      payerName: body.payerName,
    });
    if (!checked.ok) {
      return Response.json(
        { ok: false, error: "invalid_input", message: checked.error },
        { status: 400 },
      );
    }

    // 訂單不存在、或不是這個人的:同一句 not_found(不讓人拿訂單編號試出誰下了單)。
    const order = await getOrder(_ctx.services, opts.table, body.orderNo);
    if (!order || !(await reporterOwns(order.customerEmail, body.email))) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    // 一次回報取代上一次;這個付款方式不問匯款人姓名時,不碰那一欄。表還沒有 transfer_payer 欄(還沒套用
    // 更新)時也不寫,記一行 —— 回報照樣成立。
    const payerColumn = spec.ask !== "reference" && (await orderColumns(_ctx.services, opts.table)).has("transfer_payer");
    if (spec.ask !== "reference" && !payerColumn) {
      console.warn(`[commerce-kit] ${opts.table} has no transfer_payer column yet (apply the update); the payer name of ${body.orderNo} is not saved`);
    }
    const extras = {
      transferReference: checked.value.reference ?? null,
      ...(payerColumn ? { transferPayer: checked.value.payerName ?? null } : {}),
      transferReportedAt: Date.now(),
    };
    const moved = await transitionOrder(
      _ctx.services,
      opts.table,
      body.orderNo,
      "awaiting_verify",
      extras,
    );
    if (moved) return Response.json({ ok: true });

    // 已在 awaiting_verify(重報,如打錯末五碼)→ 只重寫回報欄位,狀態不動。
    //
    // 這裡**不能**再呼叫一次 transitionOrder:上面那次剛回 false,而它失敗的原因正是
    // 「awaiting_verify 不是自己的合法來源」—— 同樣的呼叫不會有不同的結果,只會安靜
    // 地丟掉客人剛改好的回報,然後回報成功(見 orders.ts 的 rewriteTransferReport)。
    const rewritten = await rewriteTransferReport(
      _ctx.services,
      opts.table,
      body.orderNo,
      extras,
    );
    if (rewritten) return Response.json({ ok: true });

    // 走到這裡:訂單不存在,或它的狀態既不能轉進 awaiting_verify 也不是
    // awaiting_verify(已付款、已取消…)。兩者對客人而言都是「這張單現在不收回報」。
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  };
}

const verifySchema = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

/** admin 核帳 handler(POST orders/:orderNo/verify,預設 auth:editor+)。 */
export function createTransferVerifyHandler(opts: {
  table: string;
  /** 匯款 providerId 解析(讀 ext.<id>.transferProvider 設定)。 */
  resolveTransferProvider: (ctx: ApiCtx) => Promise<string>;
}) {
  return async function transferVerifyHandler(
    req: Request,
    params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let body: z.infer<typeof verifySchema>;
    try {
      body = verifySchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }

    const orderNo = params.orderNo ?? "";
    const owner = await resolveOrderOwner(ctx.services, opts.table, orderNo);
    if (owner.kind !== "core") return orderManagedResponse(owner);
    const order = await getOrder(ctx.services, opts.table, orderNo);
    if (!order) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    // 人工轉帳無法自動查到帳 —— 到帳與否只有店家的銀行看得到,所以核可
    // **不**以客人回報為前提:pending_payment(客人沒回報)也可直接核帳。
    // 退回則只對「已回報」有意義(awaiting_verify → pending_payment)。
    const approvable =
      order.status === "awaiting_verify" || order.status === "pending_payment";
    if (body.approve ? !approvable : order.status !== "awaiting_verify") {
      return Response.json(
        { ok: false, error: "illegal_state", status: order.status },
        { status: 409 },
      );
    }

    const providerId = await opts.resolveTransferProvider(ctx);
    const provider = ctx.services.providers.getById<unknown>("payment", providerId);
    if (!provider || !isManualPaymentProvider(provider)) {
      return Response.json({ ok: false, error: "not_available" }, { status: 503 });
    }

    const { reference } = await transferReportSpec(provider);
    const stamp = `${body.approve ? "核可" : "退回"} by ${ctx.user.email}` +
      (order.transferReference ? ` ${reference.label} ${order.transferReference}` : "") +
      (order.transferPayer ? ` 匯款人 ${order.transferPayer}` : "") +
      (order.status === "pending_payment" ? "（未經回報，後台直接核帳）" : "") +
      (body.note ? ` — ${body.note}` : "");

    if (body.approve) {
      // 統一結算:settleManual → payment:succeeded → markOrderPaid(hook)翻訂單。
      const outcome = await provider.settleManual(orderNo, true, stamp);
      if (!outcome.settled && !outcome.known) {
        // 付款列不存在(手改 DB / 表被清)—— 沒有錢的紀錄就不能把單翻 paid。
        return Response.json(
          { ok: false, error: "settle_failed", status: order.status },
          { status: 500 },
        );
      }
      // 防線:hook 失敗會被 HookBus 吃掉(catch-and-continue),不能讓「錢已
      // 結算、單卡在待對帳」發生 —— 直接補一次轉移,hook 已翻過則為冪等 no-op。
      await transitionOrder(ctx.services, opts.table, orderNo, "paid");
      const after = await getOrder(ctx.services, opts.table, orderNo);
      if (after?.status !== "paid") {
        // 仍不是 paid:付款列缺失(手改 DB / 表被清)之類。fail-loud。
        return Response.json(
          { ok: false, error: "settle_failed", status: after?.status },
          { status: 500 },
        );
      }
      await setOrderNote(ctx.services, opts.table, orderNo, stamp);
      return Response.json({ ok: true, status: "paid" });
    }

    await provider.settleManual(orderNo, false, stamp);
    const moved = await transitionOrder(
      ctx.services,
      opts.table,
      orderNo,
      "pending_payment",
      { note: stamp },
    );
    return Response.json({ ok: moved, status: "pending_payment" });
  };
}

// 這個 enum 是**入口**,ORDER_TRANSITIONS 才是規則 —— 兩者都要有那個值,狀態才
// 到得了。refunded 一度只存在於規則裡(paid → refunded 宣告合法、pill 顏色也備好
// 了),但三個入口(這裡、agent tool、後台按鈕)全都沒有它,所以那個狀態實際上
// 到不了、紅色 pill 是死程式碼。退款動作本身仍然刻意不做,這裡只負責記帳。
const statusSchema = z
  .object({
    to: z.enum(["shipped", "completed", "cancelled", "refunded"]),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

/** admin 狀態動作 handler(POST orders/:orderNo/status,預設 auth:editor+)。 */
export function createOrderStatusHandler(opts: { table: string }) {
  return async function orderStatusHandler(
    req: Request,
    params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let body: z.infer<typeof statusSchema>;
    try {
      body = statusSchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    const to: OrderStatus = body.to;
    if (!isOrderStatus(to)) {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    const note = body.note
      ? `${body.note} — by ${ctx.user.email}`
      : `${to} by ${ctx.user.email}`;
    let moved: boolean;
    try {
      // 訂單管理插件的訂單照舊交給它的 transition();插件停用時回 409 order_managed。
      moved = await transitionOrder(ctx.services, opts.table, params.orderNo ?? "", to, { note });
    } catch (error) {
      if (error instanceof OrderManagedError) {
        return orderManagedResponse({ kind: "unavailable", name: error.managerName });
      }
      throw error;
    }
    if (!moved) {
      return Response.json(
        { ok: false, error: "illegal_transition" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, status: to });
  };
}
