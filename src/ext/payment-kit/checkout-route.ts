import { z } from "zod";
import type { ApiCtx } from "../types";
import type { PaymentProvider } from "../capabilities";

// payment-kit:POST /api/ext/<extId>/checkout 的共用 handler 工廠(admin 測試
// 付款入口,editor+)。dispatcher 已處理 same-origin + requireAuth;這裡只驗
// body、產訂單編號、呼叫該金流的 provider。
//
// providers.getById 而非 get():get() 的 active 解析 fallback 到 id "core",
// payment capability 沒有 core 內建 provider —— 此 route 是 extension 自己的
// 測試入口,精確指向自家 provider 最誠實。其他 extension 要消費 payment 時,
// 設 core.provider.payment = "<providerId>" 後即可用 get<PaymentProvider>("payment")。

const bodySchema = z
  .object({
    amount: z.number().int().min(1).max(99_999_999),
    description: z.string().trim().min(1).max(50),
    email: z.string().email().optional(),
  })
  .strict();

/** 預設訂單編號:英數(base36 大寫),≤30 字元 —— 各家 gateway 的交集字元集。 */
function defaultOrderNo(): string {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SK${time}${rand}`;
}

export function createCheckoutHandler(
  providerId: string,
  generateOrderNo: () => string = defaultOrderNo,
) {
  return async function checkoutHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await req.json());
    } catch {
      return Response.json(
        { ok: false, error: "invalid_input" },
        { status: 400 },
      );
    }

    const provider = ctx.services.providers.getById<PaymentProvider>(
      "payment",
      providerId,
    );
    if (!provider) {
      // 理論上不會發生(route 與 provider 同一 extension,同啟同停)。
      return Response.json(
        { ok: false, error: "not_available" },
        { status: 503 },
      );
    }

    const session = await provider.createCheckout({
      orderNo: generateOrderNo(),
      amount: body.amount,
      description: body.description,
      email: body.email,
    });
    return Response.json(session, { status: session.ok ? 200 : 422 });
  };
}
