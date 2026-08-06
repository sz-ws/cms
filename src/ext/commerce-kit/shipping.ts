import { z } from "zod";
import type { ApiCtx } from "../types";
import type { ShippingConfig } from "./shipping-engine";

export * from "./shipping-engine";

// commerce-kit:運費規則引擎(Phase 3,docs/spec-commerce-kit.md)。
//
// 模型 = 配送方式(methods)+ 規則(rules):
//   - method 是客人結帳時「挑一個」的選項(宅配/店到店/面交…),各有基本運費。
//   - rule 是店家的 exception(滿額免運、離島加收、特定方式折抵…),依陣列順序
//     逐條套用 —— **順序即優先序**,不另設 priority 欄(可拖動排序比數字好懂)。
//
// 引擎是**純函式**(shipping-engine.ts,零依賴):同一個 computeShippingOptions
// 由結帳頁(client 即時試算)、運費編輯器(admin 即時預覽)與 checkout handler
// (server 重算定案)共用 —— 單一事實來源,client 算的價格永遠只是預覽。
//
// 儲存:settings JSON(如 ext.shop.shippingConfig)。運費設定是店家設定不是
// 交易資料 —— 進 settings 而非開表,改設定不影響已成立訂單(金額已凍結)。
// 設定缺席/壞掉 → null → 商店視為「未啟用運費」(結帳不出現配送選擇,運費 0),
// 與 Phase 1–2 行為一致,永不因設定壞掉擋結帳。
//
// 本檔只放 schema(驗證)+ parse + admin 儲存 handler —— zod 只進 server 與
// admin bundle,公開結帳頁 import shipping-engine 即可。

const ruleWhenSchema = z
  .object({
    methods: z.array(z.string().min(1).max(40)).max(20).optional(),
    minSubtotal: z.number().int().min(0).optional(),
    maxSubtotal: z.number().int().min(0).optional(),
    minQty: z.number().int().min(0).optional(),
    maxQty: z.number().int().min(0).optional(),
    regions: z.array(z.string().min(1).max(20)).max(30).optional(),
  })
  .strict();

const ruleEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("free") }).strict(),
  z
    .object({
      type: z.literal("add"),
      amount: z.number().int().min(-99_999).max(99_999),
    })
    .strict(),
  z
    .object({
      type: z.literal("override"),
      amount: z.number().int().min(0).max(99_999),
    })
    .strict(),
]);

const shippingRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    enabled: z.boolean().default(true),
    when: ruleWhenSchema.default({}),
    effect: ruleEffectSchema,
  })
  .strict();

const shippingMethodSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(40),
    base: z.number().int().min(0).max(99_999),
    enabled: z.boolean().default(true),
  })
  .strict();

/** 型別註記釘住 schema 輸出與 shipping-engine.ts interface 的一致性。 */
export const shippingConfigSchema: z.ZodType<ShippingConfig> = z
  .object({
    methods: z.array(shippingMethodSchema).max(10),
    rules: z.array(shippingRuleSchema).max(50).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const m of cfg.methods) {
      if (seen.has(m.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate method id "${m.id}"` });
      }
      seen.add(m.id);
    }
  });

/**
 * settings 值 → 設定物件。壞 JSON / 不合 schema / 無啟用方式 → null(未啟用)。
 * 寬容是刻意的:運費設定壞掉的正確結局是「暫時退回無運費」,不是擋住全店結帳。
 */
export function parseShippingConfig(raw: unknown): ShippingConfig | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = shippingConfigSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.methods.some((m) => m.enabled) ? parsed.data : null;
}

export interface ShippingConfigHandlerOptions {
  /** 完整 settings key(如 "ext.shop.shippingConfig")—— ScopedSettings 收完整 key。 */
  settingsKey: string;
}

/**
 * admin 儲存 handler(POST shipping-config;route 不標 public = 需登入)。
 * 以 shippingConfigSchema 全量驗證 —— 編輯器送整份設定,不做 patch(設定小,
 * 全量覆蓋比 merge 好推理)。methods 允許為空(= 關閉運費)。
 */
export function createShippingConfigHandler(opts: ShippingConfigHandlerOptions) {
  return async function shippingConfigHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let config: ShippingConfig;
    try {
      config = shippingConfigSchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    await ctx.services.settings.set({
      [opts.settingsKey]: JSON.stringify(config),
    });
    return Response.json({ ok: true });
  };
}
