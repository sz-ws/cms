import { sql } from "drizzle-orm";
import type { CoreServices } from "../services";
import {
  isOrderStatus,
  transitionSources,
  type CommerceOrder,
  type OrderAmounts,
  type OrderLine,
  type OrderStatus,
} from "./types";

/**
 * 本檔所有函式只需要 db —— 收窄依賴讓三類呼叫端共用:API handler 傳
 * ctx.services(結構相容)、admin 積木傳 { db: db() }(@/lib/db 直取,
 * 不經 services/loader,避免 registry → extension → loader 的 module-eval
 * 循環)、extension hook 同 admin。
 */
export type CommerceDb = Pick<CoreServices, "db">;

// commerce-kit:訂單表讀寫 + 狀態機轉移。
//
// 表欄位契約(extension migration 建立,表名由 extension 傳入,同 payment-kit
// 的 table 慣例;完整範例見 extensions/shop/index.ts 的 0001_orders):
//   order_no TEXT PRIMARY KEY
//   status TEXT NOT NULL                -- types.ts OrderStatus
//   lines TEXT NOT NULL                 -- OrderLine[] JSON 快照
//   subtotal / discount / shipping / total INTEGER NOT NULL
//   payment_provider TEXT NOT NULL
//   customer_name TEXT NOT NULL, customer_email TEXT NOT NULL
//   customer_phone TEXT, ship_address TEXT
//   transfer_last5 TEXT, transfer_reported_at INTEGER
//   note TEXT
//   created_at / updated_at INTEGER NOT NULL

/** 表名驗證(同 payment-kit settle.ts)—— 開發者常數,仍擋 sql.raw 注入面。 */
const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

function assertTable(table: string): void {
  if (!TABLE_RE.test(table)) {
    throw new Error(`[commerce-kit] invalid orders table name "${table}"`);
  }
}

interface OrderRow {
  order_no: string;
  status: string;
  lines: string;
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  payment_provider: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  ship_address: string | null;
  region: string | null;
  shipping_method: string | null;
  promo_code: string | null;
  transfer_last5: string | null;
  transfer_reported_at: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS = sql.raw(
  "order_no, status, lines, subtotal, discount, shipping, total, " +
    "payment_provider, customer_name, customer_email, customer_phone, " +
    "ship_address, region, shipping_method, promo_code, " +
    "transfer_last5, transfer_reported_at, note, " +
    "created_at, updated_at",
);

function rowToOrder(row: OrderRow): CommerceOrder {
  let lines: OrderLine[] = [];
  try {
    const parsed: unknown = JSON.parse(row.lines);
    if (Array.isArray(parsed)) lines = parsed as OrderLine[];
  } catch {
    // 快照壞掉不該讓整頁炸掉;金額欄位仍在,lines 顯示為空。
  }
  return {
    orderNo: row.order_no,
    status: isOrderStatus(row.status) ? row.status : "pending_payment",
    lines,
    amounts: {
      subtotal: row.subtotal,
      discount: row.discount,
      shipping: row.shipping,
      total: row.total,
    },
    paymentProvider: row.payment_provider,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    shipAddress: row.ship_address,
    region: row.region,
    shippingMethod: row.shipping_method,
    promoCode: row.promo_code,
    transferLast5: row.transfer_last5,
    transferReportedAt: row.transfer_reported_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateOrderInput {
  orderNo: string;
  lines: OrderLine[];
  amounts: OrderAmounts;
  paymentProvider: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  shipAddress?: string;
  region?: string;
  /** 配送方式名稱快照(設定之後改名不影響已成立訂單)。 */
  shippingMethod?: string;
  promoCode?: string;
}

/** 建立訂單(status = pending_payment)。orderNo 撞號會 throw(PK)。 */
export async function createOrder(
  deps: CommerceDb,
  table: string,
  input: CreateOrderInput,
): Promise<void> {
  assertTable(table);
  const now = Date.now();
  await deps.db.run(sql`
    INSERT INTO ${sql.raw(table)}
      (order_no, status, lines, subtotal, discount, shipping, total,
       payment_provider, customer_name, customer_email, customer_phone,
       ship_address, region, shipping_method, promo_code, created_at, updated_at)
    VALUES
      (${input.orderNo}, 'pending_payment', ${JSON.stringify(input.lines)},
       ${input.amounts.subtotal}, ${input.amounts.discount},
       ${input.amounts.shipping}, ${input.amounts.total},
       ${input.paymentProvider}, ${input.customerName}, ${input.customerEmail},
       ${input.customerPhone ?? null}, ${input.shipAddress ?? null},
       ${input.region ?? null}, ${input.shippingMethod ?? null},
       ${input.promoCode ?? null}, ${now}, ${now})
  `);
}

export async function getOrder(
  deps: CommerceDb,
  table: string,
  orderNo: string,
): Promise<CommerceOrder | null> {
  assertTable(table);
  const row = await deps.db.get<OrderRow>(sql`
    SELECT ${ROW_COLUMNS} FROM ${sql.raw(table)} WHERE order_no = ${orderNo}
  `);
  return row ? rowToOrder(row) : null;
}

export async function listOrders(
  deps: CommerceDb,
  table: string,
  opts: { status?: OrderStatus; limit?: number } = {},
): Promise<CommerceOrder[]> {
  assertTable(table);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.status
    ? await deps.db.all<OrderRow>(sql`
        SELECT ${ROW_COLUMNS} FROM ${sql.raw(table)}
        WHERE status = ${opts.status}
        ORDER BY created_at DESC LIMIT ${limit}
      `)
    : await deps.db.all<OrderRow>(sql`
        SELECT ${ROW_COLUMNS} FROM ${sql.raw(table)}
        ORDER BY created_at DESC LIMIT ${limit}
      `);
  return rows.map(rowToOrder);
}

/** 各狀態訂單數(admin 佇列 badge 用)。表未建好 → 空物件,別讓整頁炸掉。 */
export async function countByStatus(
  deps: CommerceDb,
  table: string,
): Promise<Partial<Record<OrderStatus, number>>> {
  assertTable(table);
  try {
    const rows = await deps.db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*) AS n FROM ${sql.raw(table)} GROUP BY status
    `);
    const out: Partial<Record<OrderStatus, number>> = {};
    for (const r of rows) {
      if (isOrderStatus(r.status)) out[r.status] = r.n;
    }
    return out;
  } catch {
    return {};
  }
}

export interface TransitionExtras {
  /** 一併寫入的匯款回報欄位(report-transfer 用)。 */
  transferLast5?: string;
  transferReportedAt?: number;
  /** 動作附註(核帳紀錄等)。**追加**到 note 欄(換行分隔)—— note 是審計
   *  軌跡,後面的動作不得抹掉前面的紀錄(Codex 實測抓到:「標記完成」曾把
   *  核帳紀錄蓋掉)。 */
  note?: string;
}

/**
 * 狀態機轉移:單一條件式 UPDATE `WHERE status IN (合法來源)` 爭取轉移權 ——
 * race-safe(兩個並發動作只有一個成立)且冪等(已在目標狀態 / 非法來源 → false)。
 * 合法來源由 types.ts 的 ORDER_TRANSITIONS 反查,這裡不長第二份規則。
 */
export async function transitionOrder(
  deps: CommerceDb,
  table: string,
  orderNo: string,
  to: OrderStatus,
  extras: TransitionExtras = {},
): Promise<boolean> {
  assertTable(table);
  const sources = transitionSources(to);
  if (sources.length === 0) return false; // 防禦:目前每個狀態都有至少一個來源
  const sourceList = sql.join(
    sources.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = await deps.db.all<{ orderNo: string }>(sql`
    UPDATE ${sql.raw(table)} SET
      status = ${to},
      transfer_last5 = COALESCE(${extras.transferLast5 ?? null}, transfer_last5),
      transfer_reported_at = COALESCE(${extras.transferReportedAt ?? null}, transfer_reported_at),
      note = CASE
        WHEN ${extras.note ?? null} IS NULL THEN note
        ELSE COALESCE(note || char(10), '') || ${extras.note ?? null}
      END,
      updated_at = ${Date.now()}
    WHERE order_no = ${orderNo} AND status IN (${sourceList})
    RETURNING order_no AS orderNo
  `);
  return rows.length > 0;
}

/**
 * 重寫匯款回報欄位 —— **狀態不動**,只在訂單仍為 awaiting_verify 時成立。
 *
 * 為什麼不能用 transitionOrder 做這件事:它的 `WHERE status IN (合法來源)` 是由
 * ORDER_TRANSITIONS 反查的,而能轉去 awaiting_verify 的來源只有 pending_payment
 * (awaiting_verify 不在自己的來源清單裡,那是刻意的 —— 自我轉移一旦合法,狀態機
 * 對每一個狀態都鬆一格)。所以「客人打錯末五碼、在 admin 核帳前重報一次」這條路
 * 用 transitionOrder 必然命中 0 列:新的末五碼被安靜丟掉,admin 對帳時看到的還是
 * 舊的錯號碼。修法是給它一條不經過狀態機的專屬 UPDATE,而不是把 awaiting_verify
 * 加進自己的來源清單。
 *
 * 回傳「有沒有真的改到」。呼叫端**必須**看這個值 —— 這個 bug 的另一半就是原本的
 * 程式碼不看回傳值,對著沒改到的資料回報成功。
 */
export async function rewriteTransferReport(
  deps: CommerceDb,
  table: string,
  orderNo: string,
  extras: Pick<TransitionExtras, "transferLast5" | "transferReportedAt">,
): Promise<boolean> {
  assertTable(table);
  const rows = await deps.db.all<{ orderNo: string }>(sql`
    UPDATE ${sql.raw(table)} SET
      transfer_last5 = COALESCE(${extras.transferLast5 ?? null}, transfer_last5),
      transfer_reported_at = COALESCE(${extras.transferReportedAt ?? null}, transfer_reported_at),
      updated_at = ${Date.now()}
    WHERE order_no = ${orderNo} AND status = 'awaiting_verify'
    RETURNING order_no AS orderNo
  `);
  return rows.length > 0;
}

/** 追加訂單附註(核帳紀錄等;換行分隔,同 transitionOrder 的追加語意)。
 *  不動狀態,查無此單靜默略過。 */
export async function setOrderNote(
  deps: CommerceDb,
  table: string,
  orderNo: string,
  note: string,
): Promise<void> {
  assertTable(table);
  await deps.db.run(sql`
    UPDATE ${sql.raw(table)}
    SET note = COALESCE(note || char(10), '') || ${note}, updated_at = ${Date.now()}
    WHERE order_no = ${orderNo}
  `);
}

/**
 * payment:succeeded 的統一監聽器 —— extension 在 hooks 綁定
 * `(payload) => markOrderPaid(services…, payload)`。刷卡回呼與匯款核帳都走這裡
 * (payment-kit settle.ts 統一帶 orderNo);查無此單 = 不是本商店的付款
 * (如 admin 測試付款),靜默略過。
 */
export async function markOrderPaid(
  deps: CommerceDb,
  table: string,
  payload: unknown,
): Promise<void> {
  const orderNo =
    payload !== null &&
    typeof payload === "object" &&
    "orderNo" in payload &&
    typeof (payload as { orderNo: unknown }).orderNo === "string"
      ? (payload as { orderNo: string }).orderNo
      : null;
  if (!orderNo) return;
  await transitionOrder(deps, table, orderNo, "paid");
}
