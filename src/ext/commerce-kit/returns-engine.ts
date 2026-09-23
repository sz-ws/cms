import { commitLedgerOperations, LedgerConflict, prepareTransaction } from "../ledger-kit";
import type { LedgerOperation, TransactionMutation, TransactionValue } from "../ledger-kit";
import { recordSearchClauses, type RecordSearch } from "../record-search";
import {
  CLOSED_WITHOUT_RETURN,
  REFUND_METHODS,
  RETURN_REASONS,
  RETURNABLE_ORDER_STATUSES,
  ReturnError,
  canTransitionReturn,
  isReturnStatus,
  newReturnNo,
  orderReturnBlock,
  orderStockReservationId,
  refundCap,
  returnTables,
  RETURN_SEARCH_FIELDS,
  type RefundMethod,
  type RestockProvider,
  type ReturnEvent,
  type ReturnEventAction,
  type ReturnLine,
  type ReturnReason,
  type ReturnStatus,
  type ShopReturn,
} from "./returns";
import { isOrderStatus, type OrderLine, type OrderStatus } from "./types";

// commerce-kit 1.50.0:退貨引擎(D1)。
//
// 每一次寫入(建立、每一步狀態)都是一個 ledger-kit 交易:退貨列、處理紀錄、放回
// 庫存在同一個 D1 batch 裡,任一個前提不成立(狀態已被別人改掉、可退件數被另一筆
// 退貨用掉、退款超過訂單金額)整批不寫。前提檢查在 batch 內做,所以兩個人同時按也
// 只有一個會成立。
//
// 表的契約(extension migration 建立,見 extensions/shop/schema.ts 0004_returns):
//   <prefix>_requests   退貨(return_no 主鍵)
//   <prefix>_events     處理紀錄(id = <return_no>:<動作>)
//   <prefix>_operations ledger-kit 交易收據(transactionSchema(prefix))
// 訂單表沿用 orders.ts 的契約,這裡只讀。

export interface ReturnsConfig {
  /** 訂單表,如 "ext_shop_orders"。 */
  ordersTable: string;
  /** 退貨表前綴,如 "ext_shop_return"。 */
  prefix: string;
}

/** 做這一步的人。name 會存進處理紀錄(人員之後改名或刪除,紀錄照舊)。 */
export interface ReturnActor {
  id: string;
  name: string;
}

export interface ReturnableLine {
  productId: string;
  name: string;
  unitPrice: number;
  ordered: number;
  /** 還能退的件數(訂購數 − 未拒絕、未取消的退貨已占用的件數)。 */
  returnable: number;
}

export interface ReturnableOrder {
  orderNo: string;
  status: OrderStatus;
  /** 商品金額合計(單價 × 件數)。 */
  subtotal: number;
  /** 訂單折扣(優惠碼)。建議退款金額按 (subtotal − discount) / subtotal 折算。 */
  discount: number;
  total: number;
  customerName: string;
  customerPhone: string | null;
  createdAt: number;
  /** 訂單狀態允許退貨(已出貨、已完成)。 */
  eligible: boolean;
  lines: ReturnableLine[];
  /** 這張訂單所有退貨已登記的退款合計。 */
  refunded: number;
  returns: { returnNo: string; status: ReturnStatus }[];
}

export interface CreateReturnInput {
  orderNo: string;
  lines: { productId: string; qty: number }[];
  reason: ReturnReason;
  note?: string;
  requestedAmount: number;
}

export interface TransitionReturnInput {
  to: ReturnStatus;
  note?: string;
  /** 只在 to = received:每項放回庫存幾件(0 或不列 = 不放回)。 */
  restock?: { productId: string; qty: number }[];
  /** 只在 to = refunded。 */
  refund?: { amount: number; method: RefundMethod; note?: string };
}

export interface ReturnStock {
  /** 有庫存 provider(可以放回庫存)。 */
  enabled: boolean;
  /** 商品 id → 有沒有庫存帳。 */
  tracked: Record<string, boolean>;
  /** 商品 id → 這張訂單有沒有從庫存扣走這項(預留已扣下)。只有扣過的能放回。 */
  taken: Record<string, boolean>;
}

interface OrderRow {
  order_no: string;
  status: string;
  lines: string;
  subtotal: number;
  discount: number;
  total: number;
  customer_name: string;
  customer_phone: string | null;
  created_at: number;
}

interface ReturnRow {
  return_no: string;
  order_no: string;
  status: string;
  lines: string;
  reason: string;
  note: string | null;
  requested_amount: number;
  refund_amount: number | null;
  refund_method: string | null;
  refund_note: string | null;
  refunded_at: number | null;
  customer_name: string;
  customer_phone: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  action: string;
  actor_id: string;
  actor_name: string;
  note: string | null;
  data: string | null;
  created_at: number;
}

const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;
const MAX_AMOUNT = 99_999_999;
/** ledger-kit 的預留 id 上限(operations.ts checkedText)。 */
const RESERVATION_ID_MAX = 128;
const RETURN_COLUMNS =
  "return_no, order_no, status, lines, reason, note, requested_amount, refund_amount, " +
  "refund_method, refund_note, refunded_at, customer_name, customer_phone, created_by, " +
  "created_at, updated_at";

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asArray<T>(raw: string | null): T[] {
  const value = parseJson(raw);
  return Array.isArray(value) ? (value as T[]) : [];
}

function isReason(value: string): value is ReturnReason {
  return (RETURN_REASONS as readonly string[]).includes(value);
}

function isMethod(value: string): value is RefundMethod {
  return (REFUND_METHODS as readonly string[]).includes(value);
}

function rowToReturn(row: ReturnRow): ShopReturn {
  const lines = asArray<ReturnLine>(row.lines).map((l) => ({
    productId: String(l.productId),
    name: String(l.name),
    unitPrice: Number(l.unitPrice) || 0,
    qty: Number(l.qty) || 0,
    restocked: Number(l.restocked) || 0,
  }));
  return {
    returnNo: row.return_no,
    orderNo: row.order_no,
    status: isReturnStatus(row.status) ? row.status : "requested",
    lines,
    reason: isReason(row.reason) ? row.reason : "other",
    note: row.note,
    requestedAmount: row.requested_amount,
    refund:
      row.refund_amount !== null && row.refunded_at !== null
        ? {
            amount: row.refund_amount,
            method: row.refund_method && isMethod(row.refund_method) ? row.refund_method : "other",
            note: row.refund_note,
            at: row.refunded_at,
          }
        : null,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: EventRow): ReturnEvent {
  const data = parseJson(row.data) as Pick<ReturnEvent, "restocked" | "refund"> | null;
  return {
    id: row.id,
    action: row.action as ReturnEventAction,
    actorId: row.actor_id,
    actorName: row.actor_name,
    note: row.note,
    ...(data?.restocked ? { restocked: data.restocked } : {}),
    ...(data?.refund ? { refund: data.refund } : {}),
    at: row.created_at,
  };
}

/** 同一商品合併成一項(訂單快照與輸入都可能重複列)。 */
function mergeQty(items: readonly { productId: string; qty: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item.productId, (out.get(item.productId) ?? 0) + item.qty);
  return out;
}

/**
 * 未拒絕、未取消的退貨已占用的件數(商品 id → 件數)。可退件數(lookupOrder)與「都退完
 * 了」(fullyReturned)都由這裡算,規則只有一份。
 */
function takenQty(rows: readonly { status: string; lines: string }[]): Map<string, number> {
  const taken = new Map<string, number>();
  for (const r of rows) {
    if (!isReturnStatus(r.status) || CLOSED_WITHOUT_RETURN.includes(r.status)) continue;
    for (const [productId, qty] of mergeQty(asArray<ReturnLine>(r.lines))) {
      taken.set(productId, (taken.get(productId) ?? 0) + qty);
    }
  }
  return taken;
}

const guard = (sql: string, ...args: TransactionValue[]): TransactionMutation => ({
  kind: "guard",
  condition: { sql, args },
});

export function createReturnsEngine(
  db: D1Database,
  config: ReturnsConfig,
  stock: RestockProvider | null = null,
) {
  if (!TABLE_RE.test(config.ordersTable)) {
    throw new Error(`[commerce-kit] invalid orders table name "${config.ordersTable}"`);
  }
  const t = returnTables(config.prefix);
  const orders = config.ordersTable;
  const openStatuses = RETURNABLE_ORDER_STATUSES.map(() => "?").join(", ");
  const closedStatuses = CLOSED_WITHOUT_RETURN.map(() => "?").join(", ");

  async function commit(id: string, actor: ReturnActor, reason: string, mutations: TransactionMutation[], ops: LedgerOperation[] = []) {
    await commitLedgerOperations(
      { id, actor: { type: "user", id: actor.id }, reason },
      [prepareTransaction(db, config.prefix, mutations), ...ops],
    );
  }

  async function get(returnNo: string): Promise<ShopReturn | null> {
    const row = await db
      .prepare(`SELECT ${RETURN_COLUMNS} FROM ${t.returns} WHERE return_no = ?`)
      .bind(returnNo)
      .first<ReturnRow>();
    return row ? rowToReturn(row) : null;
  }

  async function lookupOrder(orderNo: string): Promise<ReturnableOrder | null> {
    const order = await db
      .prepare(
        `SELECT order_no, status, lines, subtotal, discount, total, customer_name, customer_phone, created_at FROM ${orders} WHERE order_no = ?`,
      )
      .bind(orderNo)
      .first<OrderRow>();
    if (!order) return null;
    const existing = (
      await db
        .prepare(`SELECT return_no, status, lines, refund_amount FROM ${t.returns} WHERE order_no = ? ORDER BY created_at, return_no`)
        .bind(orderNo)
        .all<{ return_no: string; status: string; lines: string; refund_amount: number | null }>()
    ).results;
    const taken = takenQty(existing);
    const orderLines = asArray<OrderLine>(order.lines);
    const ordered = mergeQty(orderLines);
    const lines: ReturnableLine[] = [...ordered].map(([productId, qty]) => {
      const first = orderLines.find((l) => l.productId === productId)!;
      return {
        productId,
        name: first.name,
        unitPrice: first.unitPrice,
        ordered: qty,
        returnable: Math.max(0, qty - (taken.get(productId) ?? 0)),
      };
    });
    const status: OrderStatus = isOrderStatus(order.status) ? order.status : "pending_payment";
    return {
      orderNo: order.order_no,
      status,
      subtotal: order.subtotal,
      discount: order.discount,
      total: order.total,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      createdAt: order.created_at,
      eligible: RETURNABLE_ORDER_STATUSES.includes(status),
      lines,
      refunded: existing.reduce((sum, r) => sum + (r.refund_amount ?? 0), 0),
      returns: existing.map((r) => ({
        returnNo: r.return_no,
        status: isReturnStatus(r.status) ? r.status : "requested",
      })),
    };
  }

  /**
   * 這些訂單裡商品都已經申請退貨的(每一項未拒絕、未取消的退貨件數 ≥ 訂購件數):訂單
   * 畫面用它收起「申請退貨」,規則同 lookupOrder 的可退件數。訂單編號以一個 JSON 參數
   * 送進去 —— D1 一個查詢最多 100 個參數,一頁訂單就有 100 筆。
   */
  async function fullyReturned(orderNos: readonly string[]): Promise<string[]> {
    const unique = [...new Set(orderNos)];
    if (unique.length === 0) return [];
    const list = JSON.stringify(unique);
    const [orderRows, returnRows] = await Promise.all([
      db
        .prepare(`SELECT order_no, lines FROM ${orders} WHERE order_no IN (SELECT value FROM json_each(?))`)
        .bind(list)
        .all<{ order_no: string; lines: string }>(),
      db
        .prepare(`SELECT order_no, status, lines FROM ${t.returns} WHERE order_no IN (SELECT value FROM json_each(?))`)
        .bind(list)
        .all<{ order_no: string; status: string; lines: string }>(),
    ]);
    const byOrder = new Map<string, { status: string; lines: string }[]>();
    for (const r of returnRows.results) {
      const rows = byOrder.get(r.order_no);
      if (rows) rows.push(r);
      else byOrder.set(r.order_no, [r]);
    }
    return orderRows.results
      .filter((order) => {
        const ordered = mergeQty(asArray<OrderLine>(order.lines));
        const taken = takenQty(byOrder.get(order.order_no) ?? []);
        return ordered.size > 0 && [...ordered].every(([productId, qty]) => (taken.get(productId) ?? 0) >= qty);
      })
      .map((order) => order.order_no);
  }

  async function create(actor: ReturnActor, input: CreateReturnInput): Promise<ShopReturn> {
    const wanted = [...mergeQty(input.lines)].filter(([, qty]) => qty > 0);
    if (wanted.length === 0 || !isReason(input.reason)) throw new ReturnError(400, "invalid_input");
    if (!Number.isSafeInteger(input.requestedAmount) || input.requestedAmount < 0) {
      throw new ReturnError(400, "invalid_input");
    }
    const order = await lookupOrder(input.orderNo);
    if (!order) throw new ReturnError(404, "order_not_found");
    const block = orderReturnBlock(order.status);
    if (block) throw new ReturnError(409, block);
    const lines: ReturnLine[] = [];
    for (const [productId, qty] of wanted) {
      const line = order.lines.find((l) => l.productId === productId);
      if (!line) throw new ReturnError(400, "invalid_input");
      if (qty > line.returnable) throw new ReturnError(409, "qty_exceeds");
      lines.push({ productId, name: line.name, unitPrice: line.unitPrice, qty, restocked: 0 });
    }
    // 申請金額不超過退回這幾件的商品金額加運費,也不超過訂單還沒退的金額(refundCap;
    // 實際退款在「登記退款」時再擋一次,訂單合計另在 batch 內確認)。
    if (input.requestedAmount > refundCap(order, lines)) throw new ReturnError(409, "amount_exceeds");

    const returnNo = newReturnNo();
    const now = Date.now();
    const note = input.note?.trim() || null;
    const mutations: TransactionMutation[] = [
      guard(
        `EXISTS (SELECT 1 FROM ${orders} WHERE order_no = ? AND status IN (${openStatuses}))`,
        order.orderNo,
        ...RETURNABLE_ORDER_STATUSES,
      ),
      // 可退件數在 batch 內再算一次:兩筆退貨同時建立,只有一筆拿得到最後那幾件。
      ...lines.map((line) =>
        guard(
          `(SELECT COALESCE(SUM(json_extract(l.value, '$.qty')), 0) FROM ${t.returns} r, json_each(r.lines) l ` +
            `WHERE r.order_no = ? AND r.status NOT IN (${closedStatuses}) AND json_extract(l.value, '$.productId') = ?) + ? <= ?`,
          order.orderNo,
          ...CLOSED_WITHOUT_RETURN,
          line.productId,
          line.qty,
          order.lines.find((l) => l.productId === line.productId)!.ordered,
        ),
      ),
      {
        kind: "insert",
        table: t.returns,
        values: {
          return_no: returnNo,
          order_no: order.orderNo,
          status: "requested",
          lines: JSON.stringify(lines),
          reason: input.reason,
          note,
          requested_amount: input.requestedAmount,
          customer_name: order.customerName,
          customer_phone: order.customerPhone,
          created_by: actor.id,
          created_at: now,
          updated_at: now,
        },
      },
      eventInsert(returnNo, "created", actor, note, null, now),
    ];
    try {
      await commit(`return:${returnNo}:created`, actor, "return created", mutations);
    } catch (error) {
      if (error instanceof LedgerConflict) throw new ReturnError(409, "changed");
      throw error;
    }
    return (await get(returnNo))!;
  }

  function eventInsert(
    returnNo: string,
    action: ReturnEventAction,
    actor: ReturnActor,
    note: string | null,
    data: Pick<ReturnEvent, "restocked" | "refund"> | null,
    at: number,
  ): TransactionMutation {
    return {
      kind: "insert",
      table: t.events,
      values: {
        id: `${returnNo}:${action}`,
        return_no: returnNo,
        action,
        actor_id: actor.id,
        actor_name: actor.name.slice(0, 120) || actor.id,
        note,
        data: data ? JSON.stringify(data) : null,
        created_at: at,
      },
    };
  }

  async function transition(actor: ReturnActor, returnNo: string, input: TransitionReturnInput): Promise<ShopReturn> {
    const current = await get(returnNo);
    if (!current) throw new ReturnError(404, "not_found");
    // 同一步按兩次(或重送)= 已經做完了,不是錯誤。
    if (current.status === input.to) return current;
    if (!canTransitionReturn(current.status, input.to)) throw new ReturnError(409, "illegal_transition");

    const now = Date.now();
    let note = input.note?.trim() || null;
    const values: Record<string, TransactionValue> = { status: input.to, updated_at: now };
    const mutations: TransactionMutation[] = [
      guard(`EXISTS (SELECT 1 FROM ${t.returns} WHERE return_no = ? AND status = ?)`, returnNo, current.status),
    ];
    const ops: LedgerOperation[] = [];
    let data: Pick<ReturnEvent, "restocked" | "refund"> | null = null;

    if (input.to === "received") {
      const restock = mergeQty(input.restock ?? []);
      for (const [productId, qty] of restock) {
        const line = current.lines.find((l) => l.productId === productId);
        if (!line || !Number.isSafeInteger(qty) || qty < 0 || qty > line.qty) {
          throw new ReturnError(400, "invalid_input");
        }
      }
      const back = current.lines
        .map((line) => ({ line, qty: restock.get(line.productId) ?? 0 }))
        .filter(({ qty }) => qty > 0);
      if (back.length > 0) {
        if (!stock) throw new ReturnError(409, "stock_unavailable");
        const found = await stockFor(current.orderNo, back.map(({ line }) => line.productId));
        if (back.some(({ line }) => !found.tracked[line.productId])) throw new ReturnError(409, "stock_untracked");
        // 只放回這張訂單扣走的。跨退貨的合計不會超過扣走的件數:每筆退貨只放回自己的
        // 件數,而同一項的退貨件數加起來不超過訂購件數(= 預留件數)。
        if (back.some(({ line }) => !found.taken[line.productId])) throw new ReturnError(409, "stock_not_taken");
        ops.push(...back.map(({ line, qty }) => stock.prepareRestock(line.productId, qty)));
        data = { restocked: back.map(({ line, qty }) => ({ name: line.name, qty })) };
      }
      values.lines = JSON.stringify(
        current.lines.map((line) => ({ ...line, restocked: restock.get(line.productId) ?? 0 })),
      );
    }

    if (input.to === "refunded") {
      const refund = input.refund;
      if (
        !refund ||
        !Number.isSafeInteger(refund.amount) ||
        refund.amount < 1 ||
        refund.amount > MAX_AMOUNT ||
        !isMethod(refund.method)
      ) {
        throw new ReturnError(400, "invalid_input");
      }
      const order = await lookupOrder(current.orderNo);
      if (!order) throw new ReturnError(404, "order_not_found");
      const others = order.refunded - (current.refund?.amount ?? 0);
      // 退款不超過這筆退貨的商品金額加運費(退貨的品項建立後不再變,不必進 batch),也不
      // 超過訂單還沒退的金額。
      if (refund.amount > refundCap({ ...order, refunded: others }, current.lines)) {
        throw new ReturnError(409, "amount_exceeds");
      }
      // 同一張訂單的退款合計不超過訂單金額,在 batch 內再確認一次。
      mutations.push(
        guard(
          `(SELECT COALESCE(SUM(refund_amount), 0) FROM ${t.returns} WHERE order_no = ? AND return_no <> ? AND refund_amount IS NOT NULL) + ? ` +
            `<= (SELECT total FROM ${orders} WHERE order_no = ?)`,
          current.orderNo,
          returnNo,
          refund.amount,
          current.orderNo,
        ),
      );
      const refundNote = refund.note?.trim() || null;
      values.refund_amount = refund.amount;
      values.refund_method = refund.method;
      values.refund_note = refundNote;
      values.refunded_at = now;
      note = note ?? refundNote;
      data = { refund: { amount: refund.amount, method: refund.method } };
    }

    mutations.push(
      { kind: "update", table: t.returns, values, where: { sql: "return_no = ?", args: [returnNo] } },
      eventInsert(returnNo, input.to as ReturnEventAction, actor, note, data, now),
    );
    try {
      await commit(`return:${returnNo}:${input.to}`, actor, `return ${input.to}`, mutations, ops);
    } catch (error) {
      if (!(error instanceof LedgerConflict)) throw error;
      // 別人剛好做了同一步:結果一樣,當成功。其餘(狀態被改走、金額被占用)要重新整理。
      const after = await get(returnNo);
      if (after?.status === input.to) return after;
      throw new ReturnError(409, "changed");
    }
    return (await get(returnNo))!;
  }

  async function list(opts: { status?: ReturnStatus; search?: RecordSearch; limit?: number } = {}): Promise<ShopReturn[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const search = recordSearchClauses(RETURN_SEARCH_FIELDS, opts.search ?? {});
    const clauses = [...(opts.status ? ["status = ?"] : []), ...search.clauses];
    const args = [...(opts.status ? [opts.status] : []), ...search.args];
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await db
      .prepare(`SELECT ${RETURN_COLUMNS} FROM ${t.returns} ${where} ORDER BY created_at DESC, return_no DESC LIMIT ?`)
      .bind(...args, limit)
      .all<ReturnRow>();
    return rows.results.map(rowToReturn);
  }

  /** 各狀態筆數;有搜尋條件時只算符合的(和列表一致)。 */
  async function counts(search: RecordSearch = {}): Promise<Partial<Record<ReturnStatus, number>>> {
    const found = recordSearchClauses(RETURN_SEARCH_FIELDS, search);
    const where = found.clauses.length ? `WHERE ${found.clauses.join(" AND ")}` : "";
    const rows = await db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${t.returns} ${where} GROUP BY status`)
      .bind(...found.args)
      .all<{ status: string; n: number }>();
    const out: Partial<Record<ReturnStatus, number>> = {};
    for (const r of rows.results) if (isReturnStatus(r.status)) out[r.status] = r.n;
    return out;
  }

  async function events(returnNo: string): Promise<ReturnEvent[]> {
    const rows = await db
      .prepare(`SELECT id, action, actor_id, actor_name, note, data, created_at FROM ${t.events} WHERE return_no = ? ORDER BY created_at, rowid`)
      .bind(returnNo)
      .all<EventRow>();
    return rows.results.map(rowToEvent);
  }

  /** 這張訂單的這些商品能不能放回庫存:有沒有庫存帳、這張訂單有沒有扣走。 */
  async function stockFor(orderNo: string, productIds: readonly string[]): Promise<ReturnStock> {
    if (!stock) return { enabled: false, tracked: {}, taken: {} };
    const [balances, reservations] = await Promise.all([
      Promise.all(productIds.map((id) => stock.getBalance(id))),
      Promise.all(
        productIds.map((id) => {
          const reservationId = orderStockReservationId(orderNo, id);
          // 超過 ledger-kit 的 id 長度就不可能預留過(預留時同樣會被擋),不必問。
          return reservationId.length > RESERVATION_ID_MAX ? null : stock.getReservation(id, reservationId);
        }),
      ),
    ]);
    return {
      enabled: true,
      tracked: Object.fromEntries(productIds.map((id, i) => [id, balances[i] !== null])),
      taken: Object.fromEntries(productIds.map((id, i) => [id, reservations[i]?.state === "captured"])),
    };
  }

  return { get, lookupOrder, fullyReturned, create, transition, list, counts, events, stockFor };
}

export type ReturnsEngine = ReturnType<typeof createReturnsEngine>;

/** 表還沒建(商店更新還沒套用)時 D1 的錯誤。 */
export function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}
