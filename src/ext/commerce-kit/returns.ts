import type { LedgerBalance, LedgerOperation, LedgerReservation } from "../ledger-kit";
import type { RecordSearchFields } from "../record-search";
import type { StatusSetDecl } from "../record-status";
import type { OrderStatus } from "./types";

// commerce-kit 1.50.0:退貨(return)的型別與狀態機 —— 單一事實來源。
//
// 一筆退貨屬於一張訂單:退哪幾項、各幾件、原因、說明、申請退款金額。退貨是訂單旁邊
// 的**獨立紀錄**,不改訂單本身的狀態機:部分退貨很常見,訂單仍是「已完成」,退了什麼
// 看它的退貨紀錄。受管訂單(私有插件接管的訂單)因此也不必開新的轉移路徑。
//
// 狀態:
//   requested(申請中)→ approved(已同意)/ rejected(已拒絕)/ cancelled(已取消)
//   approved → received(已收到退貨)/ refunded(直接退款,不收回商品)/ cancelled
//   received → refunded / completed(不退款直接結案,例如換貨)
//   refunded → completed
// 轉移圖沒有迴圈:每個狀態一筆退貨最多到一次。這讓「退貨編號 + 目標狀態」可以當
// 這一步的冪等鍵(事件 id、ledger command id),重送同一步不會做兩次。
//
// 錢:這裡只**記錄**退款(金額、方式、備註)。CMS 不會替店家把錢退回金流或銀行 ——
// 閘道退款 API 刻意不做(spec-payment-capability.md §6),後台畫面照實說。
//
// 庫存:收到退貨時可以把數量放回庫存,和狀態變更同一個 D1 batch(ledger-kit)。
// 庫存插件不是 core 的一部分,這裡只認下面的 RestockProvider 形狀(capability
// "inventory"、provider id "inventory",SKU = 商品 id)。沒有這個 provider 時只記錄。
// 只放回這張訂單真的從庫存扣走的(預留 orderStockReservationId 已扣下):沒扣過庫存
// 的訂單(舊結帳、啟用庫存前的訂單)放回去會憑空多出庫存、之後超賣。

export type ReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "received"
  | "refunded"
  | "completed"
  | "cancelled";

/** 合法轉移(from → to[])。引擎由這張表判斷,不另寫第二份規則。 */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["received", "refunded", "cancelled"],
  received: ["refunded", "completed"],
  refunded: ["completed"],
  rejected: [],
  completed: [],
  cancelled: [],
};

export const RETURN_STATUSES = Object.keys(RETURN_TRANSITIONS) as ReturnStatus[];

export function isReturnStatus(value: string): value is ReturnStatus {
  return value in RETURN_TRANSITIONS;
}

export function canTransitionReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[from].includes(to);
}

/** 已拒絕、已取消的退貨不佔「可退數量」;其餘(含已完成)都算已經退出去的件數。 */
export const CLOSED_WITHOUT_RETURN: readonly ReturnStatus[] = ["rejected", "cancelled"];

/** 客人手上有貨的訂單才能退貨。還沒出貨的要取消訂單,不是退貨。 */
export const RETURNABLE_ORDER_STATUSES: readonly OrderStatus[] = ["shipped", "completed"];

/**
 * 訂單為什麼不能退貨(null = 可以):已取消、已退款的訂單是 order_closed;其餘(還沒
 * 出貨)是 order_not_returnable —— 兩者給店家的下一步不同。
 */
export function orderReturnBlock(status: OrderStatus): "order_not_returnable" | "order_closed" | null {
  if (RETURNABLE_ORDER_STATUSES.includes(status)) return null;
  return status === "cancelled" || status === "refunded" ? "order_closed" : "order_not_returnable";
}

/** 退回這幾件的商品金額:下單單價 × 件數。訂單沒有逐項折扣,單價就是這一項的售價。 */
function returnItemsAmount(items: readonly { unitPrice: number; qty: number }[]): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}

/** 退款上限要用的訂單金額:商品金額、折扣、訂單金額,與所有退貨已登記的退款合計。 */
export interface RefundOrderAmounts {
  subtotal: number;
  discount: number;
  total: number;
  refunded: number;
}

/**
 * 這張訂單的運費:由 checkout 的 total = subtotal − discount + shipping 反推,退貨引擎
 * 與後台畫面只需要 subtotal、discount、total 三個數字。
 */
export function orderShipping(order: Pick<RefundOrderAmounts, "subtotal" | "discount" | "total">): number {
  return Math.max(0, order.total - Math.max(0, order.subtotal - order.discount));
}

/**
 * 一筆退貨最多退多少:退回這幾件的商品金額加上這張訂單的運費,也不超過這張訂單還沒退
 * 的金額。其他沒退的商品不算 —— 從運費 150 的訂單退一件 150 元的商品,上限是 300,不是
 * 整張訂單的金額。運費算進來,是因為整張退、或瑕疵品由店家負擔運費時要能連運費一起退;
 * 同一張訂單的多筆退貨都能退運費,合計仍受「訂單還沒退的金額」與 batch 內的訂單總額擋。
 * 申請金額(建立時)與實際退款(登記退款時)都用這個上限,後台欄位的 max 也是。
 */
export function refundCap(order: RefundOrderAmounts, items: readonly { unitPrice: number; qty: number }[]): number {
  return Math.max(0, Math.min(returnItemsAmount(items) + orderShipping(order), order.total - order.refunded));
}

/** 上限裡有多少是運費(0 = 沒有運費,或訂單剩下能退的連商品金額都不到)。後台提示用。 */
export function refundCapShipping(order: RefundOrderAmounts, items: readonly { unitPrice: number; qty: number }[]): number {
  return Math.max(0, Math.min(orderShipping(order), refundCap(order, items) - returnItemsAmount(items)));
}

/**
 * 建議退款金額:退回件數的實付價格。單價 × 件數按訂單折扣的比例折算(折扣照商品金額
 * 平均分攤,同 checkout 的 total = subtotal − discount + shipping),不含運費;不超過
 * 這張訂單還沒退的金額。店家可以改,最多到 refundCap(例如不扣折扣、連運費一起退)。
 */
export function suggestedRefund(order: RefundOrderAmounts, items: readonly { unitPrice: number; qty: number }[]): number {
  const gross = returnItemsAmount(items);
  const paid =
    order.subtotal > 0
      ? Math.round((gross * Math.max(0, order.subtotal - order.discount)) / order.subtotal)
      : gross;
  return Math.max(0, Math.min(paid, order.total - order.refunded));
}

/** 退貨原因(代號;名稱在 i18n 字典 `returns.reason.<代號>`)。 */
export const RETURN_REASONS = [
  "defective",
  "wrong_item",
  "not_as_described",
  "changed_mind",
  "other",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** 退款方式(代號;名稱在 i18n 字典 `returns.method.<代號>`)。 */
export const REFUND_METHODS = ["original", "transfer", "cash", "other"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** 退貨的一項:下單快照(名稱、單價)+ 退幾件 + 收到時放回庫存幾件。 */
export interface ReturnLine {
  productId: string;
  name: string;
  /** 下單時的單價(整數 TWD)。 */
  unitPrice: number;
  qty: number;
  /** 收到退貨時放回庫存的件數(0 = 沒放回)。 */
  restocked: number;
}

export interface ReturnRefund {
  amount: number;
  method: RefundMethod;
  note: string | null;
  at: number;
}

export interface ShopReturn {
  returnNo: string;
  orderNo: string;
  status: ReturnStatus;
  lines: ReturnLine[];
  reason: ReturnReason;
  note: string | null;
  /** 申請退款金額(整數 TWD)。實際退多少記在 refund。 */
  requestedAmount: number;
  refund: ReturnRefund | null;
  /** 建立當下從訂單複製過來(搜尋與列表用)。 */
  customerName: string;
  customerPhone: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 處理紀錄的動作:建立,或轉到某個狀態。 */
export type ReturnEventAction = "created" | Exclude<ReturnStatus, "requested">;

export interface ReturnEvent {
  id: string;
  action: ReturnEventAction;
  actorId: string;
  actorName: string;
  note: string | null;
  /** 這一步放回庫存的項目(只有 received)。 */
  restocked?: { name: string; qty: number }[];
  /** 這一步登記的退款(只有 refunded)。 */
  refund?: { amount: number; method: RefundMethod };
  at: number;
}

/**
 * 退貨引擎要的庫存能力。私有庫存插件的 provider(capability "inventory",id
 * "inventory")結構上就是這個形狀;core 不 import 它。
 *
 * - prepareRestock:把件數加回可用庫存(ledger-kit 的 credit),和退貨的狀態變更
 *   一起 commit。
 * - getBalance:null = 這個商品沒有庫存帳,不能放回(放回會憑空開始管它的庫存)。
 * - getReservation:訂單扣庫存時的預留(id 見 orderStockReservationId)。狀態是
 *   captured(已扣下)才表示這張訂單真的拿走了庫存,才能放回。
 */
export interface RestockProvider {
  prepareRestock(sku: string, qty: number): LedgerOperation;
  getBalance(sku: string): Promise<LedgerBalance | null>;
  getReservation(sku: string, reservationId: string): Promise<Pick<LedgerReservation, "state"> | null>;
}

/**
 * 訂單從庫存扣貨時用的預留 id:`<訂單編號>:<商品 id>`,SKU = 商品 id。接管訂單、
 * 替訂單預留庫存的插件照這個慣例,退貨才認得出哪些件數是這張訂單扣走的。
 */
export function orderStockReservationId(orderNo: string, productId: string): string {
  return `${orderNo}:${productId}`;
}

export const RESTOCK_CAPABILITY = "inventory";
export const RESTOCK_PROVIDER_ID = "inventory";

/** 後台搜尋:退貨編號、訂單編號、客人姓名、電話,加上建立期間。 */
export const RETURN_SEARCH_FIELDS: RecordSearchFields = {
  text: ["return_no", "order_no", "customer_name"],
  phone: ["customer_phone"],
  date: "created_at",
};

/**
 * 狀態組(core 1.40.0)。全站識別是 `<extId>:returns`;站台用 filter:statusSets 改名。
 * 需要店家動手的(申請中、已收到退貨)用 amber。
 */
export const RETURN_STATUS_SET: StatusSetDecl = {
  id: "returns",
  statuses: {
    requested: { label: { en: "Requested", "zh-Hant": "申請中" }, tone: "amber" },
    approved: { label: { en: "Approved", "zh-Hant": "已同意" }, tone: "accent" },
    rejected: { label: { en: "Rejected", "zh-Hant": "已拒絕" } },
    received: { label: { en: "Item received", "zh-Hant": "已收到退貨" }, tone: "amber" },
    refunded: { label: { en: "Refunded", "zh-Hant": "已退款" }, tone: "green" },
    completed: { label: { en: "Completed", "zh-Hant": "已完成" } },
    cancelled: { label: { en: "Cancelled", "zh-Hant": "已取消" } },
  },
};

/** 引擎與 API 的錯誤:status 是 HTTP 狀態碼,code 給後台對應成字典裡的訊息。 */
export type ReturnErrorCode =
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "order_not_found"
  | "order_not_returnable"
  | "order_closed"
  | "qty_exceeds"
  | "amount_exceeds"
  | "illegal_transition"
  | "stock_unavailable"
  | "stock_untracked"
  | "stock_not_taken"
  | "changed"
  | "not_ready";

export class ReturnError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ReturnErrorCode,
  ) {
    super(code);
    this.name = "ReturnError";
  }
}

/** 退貨用的表(migration 由 extension 建;見 extensions/shop/schema.ts 的 0004_returns)。 */
export function returnTables(prefix: string) {
  if (!/^ext_[a-z][a-z0-9_]{1,32}$/.test(prefix)) {
    throw new Error(`[commerce-kit] invalid returns prefix "${prefix}"`);
  }
  return {
    returns: `${prefix}_requests`,
    events: `${prefix}_events`,
  };
}

/** 退貨編號:RT + base36 時戳 + 4 碼亂數(大寫英數,≤ 16 字)。 */
export function newReturnNo(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const rand = Array.from(bytes, (b) => (b % 36).toString(36)).join("").toUpperCase();
  return `RT${now.toString(36).toUpperCase()}${rand}`;
}
