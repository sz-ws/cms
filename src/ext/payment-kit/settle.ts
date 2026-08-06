import { sql } from "drizzle-orm";
import type { CoreServices } from "../services";

// payment-kit:訂單結算 —— gateway 回呼(provider.ts handleCallback)與人工核帳
// (manual.ts settleManual)共用的**唯一**一段結算程式。
//
// 契約:
//   - 冪等:條件式 UPDATE `WHERE order_no = ? AND status <> 'paid'` 爭取結算權,
//     只有實際翻列的請求拿到 RETURNING → hook 不會重複觸發(Notify/Return 同時
//     到達、admin 連點核可,都安全)。
//   - hook payload 統一為 { providerId, orderNo, event } —— orderNo 自 1.28.0 起
//     必帶,讓消費端(commerce)不必解讀各 gateway 形狀不一的 event。

/** 訂單表名(ext_<id>_orders)—— 開發者常數,仍驗字元集擋 sql.raw 注入面。 */
export const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

export interface SettleInput {
  orderNo: string;
  succeeded: boolean;
  tradeNo?: string;
  paymentType?: string;
  payTime?: string;
  /** 原始回呼內容 / 人工核帳附註(存入 raw_result 欄)。 */
  raw?: string;
  /** payment:succeeded hook 的 event payload。 */
  event?: unknown;
}

export interface SettleOutcome {
  /** 本次呼叫是否實際翻動了訂單列(false = 已 paid 或查無此單)。 */
  settled: boolean;
  /** 訂單列是否存在(settled=false 時用來區分「已結算」與「查無此單」)。 */
  known: boolean;
}

/**
 * 結算一筆付款訂單列(pending/failed → paid|failed),成功且實際翻列時觸發
 * payment:succeeded。表不存在或 SQL 失敗會 throw(呼叫端決定回應方式)。
 */
export async function settlePayment(
  services: CoreServices,
  table: string,
  providerId: string,
  input: SettleInput,
): Promise<SettleOutcome> {
  if (!TABLE_RE.test(table)) {
    throw new Error(`[payment-kit] invalid orders table name "${table}"`);
  }
  const settledRows = await services.db.all<{ orderNo: string }>(sql`
    UPDATE ${sql.raw(table)} SET
      status = ${input.succeeded ? "paid" : "failed"},
      trade_no = ${input.tradeNo ?? null},
      payment_type = ${input.paymentType ?? null},
      pay_time = ${input.payTime ?? null},
      raw_result = ${input.raw ?? null},
      updated_at = ${Date.now()}
    WHERE order_no = ${input.orderNo} AND status <> 'paid'
    RETURNING order_no AS orderNo
  `);
  const settled = settledRows.length > 0;

  if (settled && input.succeeded) {
    await services.hooks.doAction("payment:succeeded", {
      providerId,
      orderNo: input.orderNo,
      event: input.event,
    });
  }

  if (settled) return { settled: true, known: true };
  const existing = await services.db.get<{ orderNo: string }>(sql`
    SELECT order_no AS orderNo FROM ${sql.raw(table)}
    WHERE order_no = ${input.orderNo}
  `);
  return { settled: false, known: existing !== undefined && existing !== null };
}
