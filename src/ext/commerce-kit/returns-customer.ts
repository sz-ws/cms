import { z } from "zod";
import { getDB } from "@/lib/cf";
import { readBoundedJsonObject } from "@/lib/body-limit";
import { hitRateLimit } from "@/lib/rate-limit";
import type { ApiCtx, ApiRoute } from "../types";
import { resolveCustomerOrder } from "./customer-order";
import {
  RETURN_REASONS,
  ReturnError,
  customerReturnDays,
  customerReturnDeadline,
  type CustomerReturnBlock,
  type CustomerReturnSummary,
  type CustomerReturnView,
  type ReturnErrorCode,
  type ShopReturn,
} from "./returns";
import { createReturnsEngine, isMissingTableError, type ReturnsConfig, type ReturnsEngine } from "./returns-engine";

// commerce-kit:客人自己申請退貨的 API(extension 以 createCustomerReturnRoutes 宣告,公開路由)。
//
//   POST returns/customer   { action: "status",  orderNo, email? }                       這張訂單能不能申請、期限、還能退什麼、已經有的退貨
//                           { action: "request", orderNo, email?, lines, reason, note? } 申請(狀態 = 申請中)
//
// 什麼時候:店家設定「出貨後 N 天內」(設定 key 由 extension 給;0 = 不開放,也是預設)。訂單要已出貨或已完成。
// 沒開放時對誰都是同一個回答(查看 = 沒有東西可畫,申請 = 409 closed),不查訂單也不認人:沒開放的店多不出任何東西。
//
// 誰能呼叫(店家有開放時):這張訂單的客人(customer-order.ts)—— 訂單管理插件的訂單問它(會員看登入的人、
// 訪客帶下單的 Email),商店自己的訂單看訂單編號 + 下單的 Email。不是他的訂單和不存在的訂單是同一個 404
// not_found,而且先認人、再說別的:訂單的狀態、過期了沒、退了什麼,只有訂單的客人問得到。
//
// 多少:和店家代建同一條規則(訂購件數 − 未拒絕、未取消的退貨已占用的件數),batch 內再算一次。
// 金額:客人不填(body 是 strict,帶了金額整個請求不收);引擎帶建議退款金額,實際退多少照舊由店家決定。
//
// 查看用 POST 不用 GET:Email 是憑證,不放進網址。CSRF:core 的 dispatcher 對 public 的 POST 一樣先檢查同源。

const QUARTER = 15 * 60_000;

/**
 * 限速。每一次(查看或申請)照 IP 記;店家有開放時,申請再照 IP 多記一筆(一小時 10 次)。帶 Email 的(用訂單
 * 編號 + Email 認人)另外有認人的額度,只算猜錯的,那一份在 customer-order.ts(ORDER_EMAIL_PROOF_LIMITS:同一個
 * 訂單編號、同一個 IP 15 分鐘 10 次,所有 IP 合計 60 次)。
 */
export const CUSTOMER_RETURN_LIMITS = {
  perIp: { namespace: "commerce-return-customer-ip", limit: 60, windowMs: QUARTER },
  requestPerIp: { namespace: "commerce-return-request-ip", limit: 10, windowMs: 4 * QUARTER },
} as const;

const MAX_BODY_BYTES = 8000;

const credentials = {
  orderNo: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
  email: z.string().trim().toLowerCase().max(200).email().optional(),
};

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), ...credentials }).strict(),
  z
    .object({
      action: z.literal("request"),
      ...credentials,
      lines: z
        .array(z.object({ productId: z.string().min(1).max(100), qty: z.number().int().min(1).max(999) }).strict())
        .min(1)
        .max(50),
      reason: z.enum(RETURN_REASONS),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
]);

function fail(status: number, error: ReturnErrorCode): Response {
  return Response.json({ ok: false, error }, { status });
}

const summary = (r: ShopReturn): CustomerReturnSummary => ({
  returnNo: r.returnNo,
  status: r.status,
  lines: r.lines.map((line) => ({ name: line.name, qty: line.qty })),
  createdAt: r.createdAt,
});

const blockedView = (blocked: CustomerReturnBlock, deadline: number | null, returns: ShopReturn[]): CustomerReturnView => ({
  open: false,
  blocked,
  deadline,
  lines: [],
  returns: returns.map(summary),
});

/** 店家沒開放:沒有任何東西可畫。對每個訂單編號都一樣,所以不必先認人。 */
const CLOSED: CustomerReturnView = blockedView("closed", null, []);

/**
 * 客人的訂單頁要畫的(店家有開放時)。這張訂單的退貨都列出來:店家代建的也是他的退貨,而且它們占掉了可退件數。
 */
async function viewOf(engine: ReturnsEngine, orderNo: string, days: number, shippedAt: number | null): Promise<CustomerReturnView> {
  const returns = await engine.ofOrder(orderNo);
  const order = await engine.lookupOrder(orderNo);
  if (!order || !order.eligible) return blockedView("not_returnable", null, returns);
  const deadline = customerReturnDeadline(days, shippedAt);
  if (deadline === null) return blockedView("closed", null, returns);
  if (Date.now() > deadline) return blockedView("window_passed", deadline, returns);
  const lines = order.lines
    .filter((line) => line.returnable > 0)
    .map((line) => ({ productId: line.productId, name: line.name, returnable: line.returnable }));
  if (lines.length === 0) return blockedView("nothing_left", deadline, returns);
  return { open: true, deadline, lines, returns: returns.map(summary) };
}

export interface CustomerReturnsOptions {
  /** 「客人可以申請退貨的天數（出貨後）」的設定 key,完整的(如 "ext.shop.customerReturnDays")。 */
  daysKey: string;
}

export function createCustomerReturnRoutes(config: ReturnsConfig, opts: CustomerReturnsOptions): ApiRoute[] {
  async function handler(req: Request, _params: Record<string, string>, ctx: ApiCtx): Promise<Response> {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (await hitRateLimit(ip, CUSTOMER_RETURN_LIMITS.perIp)) return fail(429, "rate_limited");
    const raw = await readBoundedJsonObject(req, MAX_BODY_BYTES, "returns-customer");
    if (!raw.ok) return fail(raw.reason === "too_large" ? 413 : 400, "invalid_input");
    const parsed = bodySchema.safeParse(raw.value);
    if (!parsed.success) return fail(400, "invalid_input");
    const body = parsed.data;

    // 店家沒開放:到這裡為止。對每個訂單編號(是不是他的、存不存在)都是同一個回答,所以不必認人 ——
    // 沒開放的店,客人打開訂單只多這一趟,不查訂單、不查退貨,也不動用查單的限速額度。
    const days = customerReturnDays(await ctx.services.settings.get<unknown>(opts.daysKey, 0));
    if (days === 0) return body.action === "status" ? Response.json({ ok: true, view: CLOSED }) : fail(409, "closed");

    if (body.action === "request" && (await hitRateLimit(ip, CUSTOMER_RETURN_LIMITS.requestPerIp))) return fail(429, "rate_limited");

    // 帶 Email 的在這裡面先記認人的額度(對每個編號都一樣),再認人;認到了還回去。
    const customer = await resolveCustomerOrder(
      ctx,
      config.ordersTable,
      { orderNo: body.orderNo, ...(body.email !== undefined ? { email: body.email } : {}) },
      req,
    );
    if (!customer.ok) return customer.reason === "rate_limited" ? fail(429, "rate_limited") : fail(404, "not_found");

    const engine = createReturnsEngine(getDB(), config);
    try {
      if (body.action === "status") {
        return Response.json({ ok: true, view: await viewOf(engine, body.orderNo, days, customer.shippedAt) });
      }
      const created = await engine.requestByCustomer({
        orderNo: body.orderNo,
        lines: body.lines,
        reason: body.reason,
        note: body.note,
        memberId: customer.memberId,
        deadline: customerReturnDeadline(days, customer.shippedAt),
      });
      return Response.json({
        ok: true,
        returnNo: created.returnNo,
        view: await viewOf(engine, body.orderNo, days, customer.shippedAt),
      });
    } catch (error) {
      if (error instanceof ReturnError) {
        // 認過人了,訂單一定在;引擎說找不到訂單只會是編號大小寫之類對不上,照樣是 not_found。
        return error.code === "order_not_found" ? fail(404, "not_found") : fail(error.status, error.code);
      }
      // 商店的更新還沒套用(沒有退貨表):查看當作還沒有退貨、不開放;申請回一個說得出口的錯誤。
      if (isMissingTableError(error)) {
        return body.action === "status" ? Response.json({ ok: true, view: CLOSED }) : fail(503, "not_ready");
      }
      throw error;
    }
  }
  return [{ method: "POST", path: "returns/customer", public: true, handler }];
}
