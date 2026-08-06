import { sql } from "drizzle-orm";
import { z } from "zod";
import { hitRateLimit } from "@/lib/rate-limit";
import type { ApiCtx } from "../types";
import type { CommerceDb } from "./orders";

// commerce-kit:優惠碼(Phase 4,docs/spec-commerce-kit.md)。
//
// 三型:percent(打折,value = 1..100 的折扣 %)、flat(折抵固定金額)、
// freeship(免運)。折扣只作用於商品小計,免運只作用於運費 —— 兩者不互抵。
//
// 儲存開表(不進 settings):用量計數(used/max_uses)必須原子遞增,
// settings JSON 做不到 race-safe。核銷 = 條件式 UPDATE used = used + 1
// WHERE 所有資格條件,與訂單狀態機同一種紀律:資格檢查與佔用在同一條 SQL,
// 兩個並發結帳搶最後一次用量只有一個成立。
//
// 表欄位契約(extension migration 建立,表名由 extension 傳入):
//   code TEXT PRIMARY KEY               -- 儲存即大寫(輸入端 normalize)
//   label TEXT NOT NULL DEFAULT ''
//   type TEXT NOT NULL                  -- percent | flat | freeship
//   value INTEGER NOT NULL DEFAULT 0
//   min_subtotal INTEGER NOT NULL DEFAULT 0
//   max_uses INTEGER                    -- NULL = 不限次數
//   used INTEGER NOT NULL DEFAULT 0
//   starts_at INTEGER, ends_at INTEGER  -- NULL = 不限(毫秒時戳)
//   enabled INTEGER NOT NULL DEFAULT 1
//   created_at / updated_at INTEGER NOT NULL

const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

function assertTable(table: string): void {
  if (!TABLE_RE.test(table)) {
    throw new Error(`[commerce-kit] invalid promos table name "${table}"`);
  }
}

/** 客人輸入 → 儲存形:去空白、大寫。空字串 = 沒有碼。 */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export type PromoType = "percent" | "flat" | "freeship";

export interface Promo {
  code: string;
  label: string;
  type: PromoType;
  value: number;
  minSubtotal: number;
  maxUses: number | null;
  used: number;
  startsAt: number | null;
  endsAt: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface PromoRow {
  code: string;
  label: string;
  type: string;
  value: number;
  min_subtotal: number;
  max_uses: number | null;
  used: number;
  starts_at: number | null;
  ends_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS = sql.raw(
  "code, label, type, value, min_subtotal, max_uses, used, " +
    "starts_at, ends_at, enabled, created_at, updated_at",
);

function rowToPromo(row: PromoRow): Promo {
  return {
    code: row.code,
    label: row.label,
    type: row.type === "percent" || row.type === "freeship" ? row.type : "flat",
    value: row.value,
    minSubtotal: row.min_subtotal,
    maxUses: row.max_uses,
    used: row.used,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 折扣計算(純函式)。percent 向下取整;折扣封頂於小計(不出現負的應付)。 */
export function promoDiscount(
  promo: Pick<Promo, "type" | "value">,
  subtotal: number,
): number {
  if (promo.type === "percent") {
    return Math.min(subtotal, Math.floor((subtotal * promo.value) / 100));
  }
  if (promo.type === "flat") return Math.min(subtotal, promo.value);
  return 0; // freeship 的效果在運費側
}

export type PromoRejectReason =
  | "not_found"
  | "disabled"
  | "not_started"
  | "expired"
  | "exhausted"
  | "below_min_subtotal";

export type PromoQuote =
  | { ok: true; promo: Promo; discount: number; freeShipping: boolean }
  | { ok: false; reason: PromoRejectReason; minSubtotal?: number };

/** 資格檢查 + 試算(唯讀,不佔用量)。結帳頁預覽與 checkout 定案共用。 */
export async function quotePromo(
  deps: CommerceDb,
  table: string,
  code: string,
  subtotal: number,
  now: number = Date.now(),
): Promise<PromoQuote> {
  assertTable(table);
  const row = await deps.db.get<PromoRow>(sql`
    SELECT ${ROW_COLUMNS} FROM ${sql.raw(table)} WHERE code = ${code}
  `);
  if (!row) return { ok: false, reason: "not_found" };
  const promo = rowToPromo(row);
  if (!promo.enabled) return { ok: false, reason: "disabled" };
  if (promo.startsAt !== null && now < promo.startsAt) {
    return { ok: false, reason: "not_started" };
  }
  if (promo.endsAt !== null && now > promo.endsAt) {
    return { ok: false, reason: "expired" };
  }
  if (promo.maxUses !== null && promo.used >= promo.maxUses) {
    return { ok: false, reason: "exhausted" };
  }
  if (subtotal < promo.minSubtotal) {
    return { ok: false, reason: "below_min_subtotal", minSubtotal: promo.minSubtotal };
  }
  return {
    ok: true,
    promo,
    discount: promoDiscount(promo, subtotal),
    freeShipping: promo.type === "freeship",
  };
}

/**
 * 原子核銷:資格條件全部搬進 WHERE,與 used+1 同一條 SQL。回傳核銷後的 promo,
 * 佔不到(不存在/停用/過期/用罄/門檻不足)→ null。呼叫端在 payment session
 * 建立**之前**核銷 —— 金額必須先定案;session 失敗再 restorePromoUse 補回。
 */
export async function redeemPromo(
  deps: CommerceDb,
  table: string,
  code: string,
  subtotal: number,
  now: number = Date.now(),
): Promise<Promo | null> {
  assertTable(table);
  const rows = await deps.db.all<PromoRow>(sql`
    UPDATE ${sql.raw(table)} SET used = used + 1, updated_at = ${now}
    WHERE code = ${code}
      AND enabled = 1
      AND (starts_at IS NULL OR starts_at <= ${now})
      AND (ends_at IS NULL OR ends_at >= ${now})
      AND (max_uses IS NULL OR used < max_uses)
      AND min_subtotal <= ${subtotal}
    RETURNING ${ROW_COLUMNS}
  `);
  return rows.length > 0 ? rowToPromo(rows[0]) : null;
}

/** 核銷回滾(payment session 建立失敗時)。best-effort,不讓回滾失敗蓋掉主錯誤。 */
export async function restorePromoUse(
  deps: CommerceDb,
  table: string,
  code: string,
): Promise<void> {
  assertTable(table);
  try {
    await deps.db.run(sql`
      UPDATE ${sql.raw(table)} SET used = used - 1, updated_at = ${Date.now()}
      WHERE code = ${code} AND used > 0
    `);
  } catch {
    // 回滾失敗的代價是少一次可用量 —— 可在 admin 直接改,不值得讓結帳錯誤變 500。
  }
}

/** admin 列表(server component 直讀)。表未建好 → 空陣列。 */
export async function listPromos(deps: CommerceDb, table: string): Promise<Promo[]> {
  assertTable(table);
  try {
    const rows = await deps.db.all<PromoRow>(sql`
      SELECT ${ROW_COLUMNS} FROM ${sql.raw(table)} ORDER BY created_at DESC LIMIT 200
    `);
    return rows.map(rowToPromo);
  } catch {
    return [];
  }
}

// ---- API handlers(extension 以 apiRoutes 掛上)----

const quoteBodySchema = z
  .object({
    code: z.string().min(1).max(60),
    subtotal: z.number().int().min(0).max(99_999_999),
  })
  .strict();

export interface PromoQuoteHandlerOptions {
  /** 優惠碼表名(如 "ext_shop_promos")。 */
  table: string;
}

/** 公開試算 handler(POST promo-quote,public route)。唯讀,不佔用量。 */
export function createPromoQuoteHandler(opts: PromoQuoteHandlerOptions) {
  return async function promoQuoteHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (
      await hitRateLimit(ip, {
        namespace: "commerce-promo-quote",
        limit: 30,
        windowMs: 15 * 60 * 1000,
      })
    ) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    let body: z.infer<typeof quoteBodySchema>;
    try {
      body = quoteBodySchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    const code = normalizePromoCode(body.code);
    if (!CODE_RE.test(code)) {
      return Response.json({ ok: false, error: "promo_invalid", reason: "not_found" });
    }
    const quote = await quotePromo(ctx.services, opts.table, code, body.subtotal);
    if (!quote.ok) {
      // 200 而非 4xx:碼無效是正常業務結果,前端要靠 reason 顯示原因。
      return Response.json({
        ok: false,
        error: "promo_invalid",
        reason: quote.reason,
        ...(quote.minSubtotal !== undefined ? { minSubtotal: quote.minSubtotal } : {}),
      });
    }
    return Response.json({
      ok: true,
      code,
      label: quote.promo.label,
      discount: quote.discount,
      freeShipping: quote.freeShipping,
    });
  };
}

/** admin 儲存(upsert)body。 */
const saveBodySchema = z
  .object({
    code: z.string().min(1).max(60),
    label: z.string().trim().max(60).default(""),
    type: z.enum(["percent", "flat", "freeship"]),
    value: z.number().int().min(0).max(99_999_999).default(0),
    minSubtotal: z.number().int().min(0).max(99_999_999).default(0),
    maxUses: z.number().int().min(1).max(9_999_999).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.type === "percent" && (body.value < 1 || body.value > 100)) {
      ctx.addIssue({ code: "custom", message: "percent value must be 1..100" });
    }
    if (body.type === "flat" && body.value < 1) {
      ctx.addIssue({ code: "custom", message: "flat value must be >= 1" });
    }
  });

export interface PromoAdminHandlerOptions {
  table: string;
}

/** admin upsert handler(POST promos/save;route 不標 public = 需登入)。 */
export function createPromoSaveHandler(opts: PromoAdminHandlerOptions) {
  return async function promoSaveHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let body: z.infer<typeof saveBodySchema>;
    try {
      body = saveBodySchema.parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    const code = normalizePromoCode(body.code);
    if (!CODE_RE.test(code)) {
      return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
    }
    assertTable(opts.table);
    const now = Date.now();
    // upsert 不動 used —— 編輯條件不清用量;要重置就刪掉重建。
    await ctx.services.db.run(sql`
      INSERT INTO ${sql.raw(opts.table)}
        (code, label, type, value, min_subtotal, max_uses, enabled,
         created_at, updated_at)
      VALUES
        (${code}, ${body.label}, ${body.type}, ${body.value}, ${body.minSubtotal},
         ${body.maxUses}, ${body.enabled ? 1 : 0}, ${now}, ${now})
      ON CONFLICT(code) DO UPDATE SET
        label = ${body.label}, type = ${body.type}, value = ${body.value},
        min_subtotal = ${body.minSubtotal}, max_uses = ${body.maxUses},
        enabled = ${body.enabled ? 1 : 0}, updated_at = ${now}
    `);
    return Response.json({ ok: true, code });
  };
}

/** admin 刪除 handler(POST promos/delete)。 */
export function createPromoDeleteHandler(opts: PromoAdminHandlerOptions) {
  return async function promoDeleteHandler(
    req: Request,
    _params: Record<string, string>,
    ctx: ApiCtx,
  ): Promise<Response> {
    let body: { code: string };
    try {
      body = z.object({ code: z.string().min(1).max(60) }).strict().parse(await req.json());
    } catch {
      return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    assertTable(opts.table);
    await ctx.services.db.run(sql`
      DELETE FROM ${sql.raw(opts.table)} WHERE code = ${normalizePromoCode(body.code)}
    `);
    return Response.json({ ok: true });
  };
}
