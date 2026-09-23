import { z } from "zod";
import { getDB } from "@/lib/cf";
import type { ApiCtx, ApiRoute } from "../types";
import {
  REFUND_METHODS,
  RESTOCK_CAPABILITY,
  RESTOCK_PROVIDER_ID,
  RETURN_REASONS,
  ReturnError,
  type RestockProvider,
} from "./returns";
import {
  createReturnsEngine,
  isMissingTableError,
  type ReturnActor,
  type ReturnsConfig,
} from "./returns-engine";

// commerce-kit 1.50.0:退貨的 API(extension 以 createReturnsApiRoutes 宣告)。
//
//   GET  returns/order/:orderNo      建立退貨前查訂單:各項可退件數、已退款合計
//   GET  returns/:returnNo           一筆退貨:內容、處理紀錄、庫存能不能放回
//   POST returns                     建立(店家代客人建立;狀態 = 申請中)
//   POST returns/:returnNo/status    下一步(同意、拒絕、收到退貨、登記退款、完成、取消)
//
// 權限:只給 admin。退貨有客人個資與退款金額,而它唯一的畫面(extension 後台頁)本來
// 就只開給 admin;dispatcher 的預設門檻是 editor,這裡再收緊。要放寬改 RETURNS_ROLE
// 一處。

export const RETURNS_ROLE = "admin";

const orderNo = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/);
const returnNo = z.string().regex(/^RT[A-Z0-9]{4,30}$/);
const productId = z.string().min(1).max(100);

const createSchema = z
  .object({
    orderNo,
    lines: z
      .array(z.object({ productId, qty: z.number().int().min(1).max(999) }).strict())
      .min(1)
      .max(50),
    reason: z.enum(RETURN_REASONS),
    note: z.string().trim().max(500).optional(),
    requestedAmount: z.number().int().min(0).max(99_999_999),
  })
  .strict();

const transitionSchema = z
  .object({
    to: z.enum(["approved", "rejected", "received", "refunded", "completed", "cancelled"]),
    note: z.string().trim().max(500).optional(),
    restock: z
      .array(z.object({ productId, qty: z.number().int().min(0).max(999) }).strict())
      .max(50)
      .optional(),
    refund: z
      .object({
        amount: z.number().int().min(1).max(99_999_999),
        method: z.enum(REFUND_METHODS),
        note: z.string().trim().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function fail(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/** 庫存 provider:有啟用、而且長得像 RestockProvider 才用。 */
function restockProvider(ctx: ApiCtx): RestockProvider | null {
  const provider = ctx.services.providers.getById<Partial<RestockProvider>>(
    RESTOCK_CAPABILITY,
    RESTOCK_PROVIDER_ID,
  );
  return provider &&
    typeof provider.prepareRestock === "function" &&
    typeof provider.getBalance === "function" &&
    typeof provider.getReservation === "function"
    ? (provider as RestockProvider)
    : null;
}

function actorOf(ctx: ApiCtx): ReturnActor {
  return { id: ctx.user.id, name: ctx.user.name?.trim() || ctx.user.email };
}

type Handler = (req: Request, params: Record<string, string>, ctx: ApiCtx) => Promise<Response>;

/** 權限、表還沒建、引擎錯誤的共同處理。 */
function guarded(run: Handler): Handler {
  return async (req, params, ctx) => {
    if (ctx.user.role !== RETURNS_ROLE) return fail(403, "forbidden");
    try {
      return await run(req, params, ctx);
    } catch (error) {
      if (error instanceof ReturnError) return fail(error.status, error.code);
      if (isMissingTableError(error)) return fail(503, "not_ready");
      throw error;
    }
  };
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function createReturnsApiRoutes(config: ReturnsConfig): ApiRoute[] {
  const engine = (ctx: ApiCtx) => createReturnsEngine(getDB(), config, restockProvider(ctx));
  return [
    {
      method: "GET",
      path: "returns/order/:orderNo",
      handler: guarded(async (_req, params, ctx) => {
        const parsed = orderNo.safeParse(params.orderNo ?? "");
        if (!parsed.success) return fail(400, "invalid_input");
        const returns = engine(ctx);
        const order = await returns.lookupOrder(parsed.data);
        if (!order) return fail(404, "order_not_found");
        const stock = await returns.stockFor(order.orderNo, order.lines.map((l) => l.productId));
        return Response.json({ ok: true, order, stock });
      }),
    },
    {
      method: "GET",
      path: "returns/:returnNo",
      handler: guarded(async (_req, params, ctx) => {
        const parsed = returnNo.safeParse(params.returnNo ?? "");
        if (!parsed.success) return fail(400, "invalid_input");
        const returns = engine(ctx);
        const found = await returns.get(parsed.data);
        if (!found) return fail(404, "not_found");
        const [events, order, stock] = await Promise.all([
          returns.events(found.returnNo),
          returns.lookupOrder(found.orderNo),
          returns.stockFor(found.orderNo, found.lines.map((l) => l.productId)),
        ]);
        return Response.json({
          ok: true,
          return: found,
          events,
          order: order
            ? { status: order.status, subtotal: order.subtotal, discount: order.discount, total: order.total, refunded: order.refunded }
            : null,
          stock,
        });
      }),
    },
    {
      method: "POST",
      path: "returns",
      handler: guarded(async (req, _params, ctx) => {
        const parsed = createSchema.safeParse(await readJson(req));
        if (!parsed.success) return fail(400, "invalid_input");
        const created = await engine(ctx).create(actorOf(ctx), parsed.data);
        return Response.json({ ok: true, return: created });
      }),
    },
    {
      method: "POST",
      path: "returns/:returnNo/status",
      handler: guarded(async (req, params, ctx) => {
        const no = returnNo.safeParse(params.returnNo ?? "");
        const parsed = transitionSchema.safeParse(await readJson(req));
        if (!no.success || !parsed.success) return fail(400, "invalid_input");
        const updated = await engine(ctx).transition(actorOf(ctx), no.data, parsed.data);
        return Response.json({ ok: true, return: updated });
      }),
    },
  ];
}
