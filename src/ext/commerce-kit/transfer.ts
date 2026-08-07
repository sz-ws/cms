import { z } from "zod";
import { hitRateLimit } from "@/lib/rate-limit";
import { isManualPaymentProvider } from "../payment-kit/manual";
import type { ApiCtx } from "../types";
import {
  getOrder,
  rewriteTransferReport,
  setOrderNote,
  transitionOrder,
} from "./orders";
import { isOrderStatus, type OrderStatus } from "./types";

// commerce-kit:匯款流程的三個 handler。
//   1. 回報(public):客人匯完款回報帳號末五碼 → pending_payment → awaiting_verify。
//   2. 核帳(admin):對到帳 → manual provider 的 settleManual(true) → 走統一結算
//      → payment:succeeded → markOrderPaid 把訂單翻 paid。**訂單翻 paid 的路徑只有
//      hook 這一條** —— 核帳 route 自己不改訂單狀態,刷卡與匯款因此完全同構。
//      對不到 → settleManual(false) 記帳 + 訂單退回 pending_payment(客人可補匯重報)。
//   3. 出貨/完成/取消(admin):純狀態機轉移。

const reportSchema = z
  .object({
    orderNo: z.string().regex(/^[A-Z0-9]{4,30}$/),
    /** 匯款帳號末五碼 —— 台灣對帳慣例。 */
    last5: z.string().regex(/^\d{5}$/),
  })
  .strict();

/** 公開匯款回報 handler(POST transfer-report,ApiRoute.public)。 */
export function createTransferReportHandler(opts: { table: string }) {
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

    const extras = {
      transferLast5: body.last5,
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
    // 地丟掉客人剛改好的末五碼,然後回報成功(見 orders.ts 的 rewriteTransferReport)。
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
    const order = await getOrder(ctx.services, opts.table, orderNo);
    if (!order) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    // 台灣沒有 open banking —— 到帳與否只有店家的銀行 App 看得到,所以核可
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

    const stamp = `${body.approve ? "核可" : "退回"} by ${ctx.user.email}` +
      (order.transferLast5 ? ` 末五碼 ${order.transferLast5}` : "") +
      (order.status === "pending_payment" ? "(未經回報,後台直接核帳)" : "") +
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
    const moved = await transitionOrder(
      ctx.services,
      opts.table,
      params.orderNo ?? "",
      to,
      { note },
    );
    if (!moved) {
      return Response.json(
        { ok: false, error: "illegal_transition" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, status: to });
  };
}
