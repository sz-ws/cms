import { z } from "zod";
import { hitRateLimit } from "@/lib/rate-limit";
import type { ApiCtx } from "../types";
import type {
  CheckoutSession,
  ContentProvider,
  PaymentProvider,
} from "../capabilities";
import { createOrder } from "./orders";
import {
  normalizePromoCode,
  quotePromo,
  redeemPromo,
  restorePromoUse,
  promoDiscount,
} from "./promo";
import { computeShippingOptions, type ShippingConfig } from "./shipping";
import type { OrderAmounts, OrderLine } from "./types";

// commerce-kit:公開結帳協調器(POST /api/ext/<extId>/checkout,ApiRoute.public)。
// 職責鏈:rate limit → 驗 body → 讀 catalog 重新計價(**永不信 client 價格**)→
// 解析付款方式 → provider.createCheckout → 建訂單列 → 回 { orderNo, session }。
//
// 順序刻意是「先 payment session、後 commerce 訂單」:provider.createCheckout
// 成功時已寫入自己的 pending 付款列,若反過來先建訂單而 provider 失敗,會留下
// 一筆永遠付不了的 pending_payment 訂單。gateway 回呼不可能先於瀏覽器拿到
// session,所以這個順序沒有 race。

const MAX_ITEMS = 50;

const bodySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(64),
            qty: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ITEMS),
    name: z.string().trim().min(1).max(100),
    email: z.string().email().max(200),
    phone: z.string().trim().max(30).optional(),
    address: z.string().trim().max(200).optional(),
    /** 付款方式:card(gateway)或 transfer(匯款)。實際 providerId 由 settings 解析。 */
    method: z.enum(["card", "transfer"]),
    /** 收件地區(縣市字串)—— 運費規則的 regions 條件比對用。 */
    region: z.string().trim().max(20).optional(),
    /** 配送方式 id。店家啟用運費時必填(伺服器驗),未啟用時忽略。 */
    shippingMethodId: z.string().trim().max(40).optional(),
    /** 優惠碼(伺服器 normalize + 原子核銷)。 */
    promoCode: z.string().trim().max(60).optional(),
  })
  .strict();

/** 預設訂單編號:SO + base36 時戳 + 亂數(≤30 字元,各家 gateway 交集字元集)。 */
function defaultOrderNo(): string {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SO${time}${rand}`;
}

/** gateway 商品描述:首件品名 + 件數,截到 50 字(newebpay 上限)。 */
function orderDescription(lines: OrderLine[]): string {
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const first = lines[0].name;
  const label = lines.length === 1 && count === 1 ? first : `${first} 等 ${count} 件`;
  return label.length > 50 ? `${label.slice(0, 47)}…` : label;
}

export interface CommerceCheckoutOptions {
  /** 訂單表名(如 "ext_shop_orders")。 */
  table: string;
  /** 商品 content type key(預設 "catalog.product";data 需含 name + price)。 */
  productType?: string;
  /**
   * 付款方式 → providerId 解析(extension 從自家 settings 讀,如
   * ext.shop.cardProvider / ext.shop.transferProvider)。空字串 = 該方式未啟用。
   */
  resolveProvider: (
    ctx: ApiCtx,
    method: "card" | "transfer",
  ) => Promise<string>;
  /**
   * 運費設定(Phase 3)。extension 從自家 settings 讀 JSON 交給
   * parseShippingConfig;缺席/回 null = 未啟用運費(結帳不驗配送方式,運費 0)。
   */
  resolveShippingConfig?: (ctx: ApiCtx) => Promise<ShippingConfig | null>;
  /** 優惠碼表名(Phase 4)。缺席 = 未啟用優惠碼(body.promoCode 被忽略)。 */
  promoTable?: string;
  generateOrderNo?: () => string;
}

export interface CheckoutSuccessBody {
  ok: true;
  orderNo: string;
  amounts: OrderAmounts;
  session: CheckoutSession;
}

/** 公開結帳 handler 工廠。extension 以 `{ path: "checkout", public: true }` 掛上。 */
export function createCommerceCheckoutHandler(opts: CommerceCheckoutOptions) {
  const productType = opts.productType ?? "catalog.product";
  const generateOrderNo = opts.generateOrderNo ?? defaultOrderNo;

  return async function checkoutHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    // 公開端點,session 不存在 → 以 IP 為 rate-limit key(callback route 前例)。
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (
      await hitRateLimit(ip, {
        namespace: "commerce-checkout",
        limit: 20,
        windowMs: 15 * 60 * 1000,
      })
    ) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }

    // 同一商品重複列 → 合併數量(client cart 理應已合併,伺服器不賭)。
    const qtyById = new Map<string, number>();
    for (const item of body.items) {
      qtyById.set(item.productId, (qtyById.get(item.productId) ?? 0) + item.qty);
    }

    // 伺服器計價:逐件讀 catalog,published-only,價格取自 content data。
    const content = ctx.services.providers.get<ContentProvider>("content");
    const lines: OrderLine[] = [];
    for (const [productId, qty] of qtyById) {
      const entry = await content.get(productType, productId);
      if (!entry || entry.status !== "published") {
        return Response.json(
          { ok: false, error: "unknown_product", productId },
          { status: 422 },
        );
      }
      const price = entry.data.price;
      const name = entry.data.name;
      if (
        typeof price !== "number" ||
        !Number.isInteger(price) ||
        price < 0 ||
        typeof name !== "string" ||
        name.length === 0
      ) {
        return Response.json(
          { ok: false, error: "unpriced_product", productId },
          { status: 422 },
        );
      }
      lines.push({ productId, name, unitPrice: price, qty: Math.min(qty, 99) });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
    const totalQty = lines.reduce((sum, l) => sum + l.qty, 0);

    // Phase 3 運費:店家啟用時,配送方式必填且必須存在;運費由同一個純函式
    // 伺服器重算(client 算的只是預覽)。未啟用 → 沿 Phase 1–2 行為,運費 0。
    const shippingConfig = (await opts.resolveShippingConfig?.(ctx)) ?? null;
    let shipping = 0;
    let shippingMethodName: string | undefined;
    if (shippingConfig) {
      const options = computeShippingOptions(
        { subtotal, qty: totalQty, region: body.region },
        shippingConfig,
      );
      const chosen = options.find((o) => o.id === body.shippingMethodId);
      if (!chosen) {
        return Response.json(
          { ok: false, error: "invalid_shipping" },
          { status: 422 },
        );
      }
      shipping = chosen.fee;
      shippingMethodName = chosen.name;
    }

    // Phase 4 優惠碼:先唯讀試算(不合格 → 422 帶 reason,讓客人看得懂),
    // 真正佔用量的原子核銷放在 payment session 之前(金額必須先定案)。
    const promoCode =
      opts.promoTable && body.promoCode ? normalizePromoCode(body.promoCode) : "";
    let discount = 0;
    if (promoCode) {
      const quote = await quotePromo(ctx.services, opts.promoTable!, promoCode, subtotal);
      if (!quote.ok) {
        return Response.json(
          { ok: false, error: "promo_invalid", reason: quote.reason },
          { status: 422 },
        );
      }
      discount = quote.discount;
      if (quote.freeShipping) shipping = 0;
    }

    const amounts: OrderAmounts = {
      subtotal,
      discount,
      shipping,
      total: subtotal - discount + shipping,
    };
    if (amounts.total < 1 || amounts.total > 99_999_999) {
      return Response.json({ ok: false, error: "invalid_total" }, { status: 422 });
    }

    const providerId = await opts.resolveProvider(ctx, body.method);
    if (!providerId) {
      return Response.json(
        { ok: false, error: "method_not_enabled" },
        { status: 422 },
      );
    }
    const provider = ctx.services.providers.getById<PaymentProvider>(
      "payment",
      providerId,
    );
    if (!provider) {
      return Response.json({ ok: false, error: "not_available" }, { status: 503 });
    }

    // 原子核銷(佔一次用量)。quote 之後有 race 空窗(最後一次用量被搶走),
    // 所以核銷失敗仍要處理:同樣回 promo_invalid。核銷後金額以 redeem 回傳列
    // 重新推導 —— 兩次讀到的條件可能已被 admin 改過,以佔到的那筆為準。
    if (promoCode) {
      const redeemed = await redeemPromo(
        ctx.services,
        opts.promoTable!,
        promoCode,
        subtotal,
      );
      if (!redeemed) {
        return Response.json(
          { ok: false, error: "promo_invalid", reason: "exhausted" },
          { status: 422 },
        );
      }
      amounts.discount = promoDiscount(redeemed, subtotal);
      if (redeemed.type === "freeship") amounts.shipping = 0;
      amounts.total = amounts.subtotal - amounts.discount + amounts.shipping;
      if (amounts.total < 1 || amounts.total > 99_999_999) {
        await restorePromoUse(ctx.services, opts.promoTable!, promoCode);
        return Response.json({ ok: false, error: "invalid_total" }, { status: 422 });
      }
    }

    const orderNo = generateOrderNo();
    const session = await provider.createCheckout({
      orderNo,
      amount: amounts.total,
      description: orderDescription(lines),
      email: body.email,
    });
    if (!session.ok) {
      // 訂單沒成立,補回優惠碼用量(best-effort)。
      if (promoCode) {
        await restorePromoUse(ctx.services, opts.promoTable!, promoCode);
      }
      return Response.json(session, { status: 422 });
    }

    await createOrder(ctx.services, opts.table, {
      orderNo,
      lines,
      amounts,
      paymentProvider: providerId,
      customerName: body.name,
      customerEmail: body.email,
      customerPhone: body.phone,
      shipAddress: body.address,
      region: body.region,
      shippingMethod: shippingMethodName,
      promoCode: promoCode || undefined,
    });

    const res: CheckoutSuccessBody = { ok: true, orderNo, amounts, session };
    return Response.json(res);
  };
}
