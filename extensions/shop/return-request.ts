import {
  RETURNABLE_ORDER_STATUSES,
  type CustomerReturnView,
  type ReturnReason,
  type ReturnStatus,
} from "@/ext/commerce-kit/returns";
import type { OrderStatus } from "@/ext/commerce-kit/types";

// 客人在自己的訂單上申請退貨。這裡沒有 React:送到哪裡、送什麼、伺服器的錯誤怎麼說、給客人看的講法,
// 測試直接呼叫(test/shop-return-request.test.tsx)。畫面在 ReturnRequest.tsx;規則在伺服器
// (commerce-kit 的 returns-customer.ts):誰能申請、期限、件數都由它決定,這裡只是照它的回答畫。
//
// 送到哪裡:一律 POST /api/ext/shop/returns/customer。訂單是誰的由伺服器認:訪客帶查單用的下單 Email,
// 已登入的會員不帶(伺服器看登入的人)。沒有金額的欄位 —— 退多少由店家決定。

export const RETURN_REQUEST_URL = "/api/ext/shop/returns/customer";

export interface ReturnRequestOrder {
  orderNo: string;
  /** 訪客:查單用的下單 Email,每一次都一起送。已登入的會員不帶。 */
  email?: string;
}

export interface ReturnRequestValue {
  lines: { productId: string; qty: number }[];
  reason: ReturnReason;
  note?: string;
}

/** 客人看到的退貨進度(後台的名稱在狀態組 returns,那是店家的講法)。 */
export const CUSTOMER_RETURN_LABELS: Readonly<Record<ReturnStatus, string>> = {
  requested: "申請中",
  approved: "已同意",
  rejected: "已拒絕",
  received: "店家已收到退貨",
  refunded: "已退款",
  completed: "已完成",
  cancelled: "已取消",
};

/** 原因的選項,客人自己選的講法。 */
export const CUSTOMER_REASON_LABELS: Readonly<Record<ReturnReason, string>> = {
  defective: "商品有瑕疵或損壞",
  wrong_item: "收到的商品不對",
  not_as_described: "和商品說明不符",
  changed_mind: "不想要了",
  other: "其他",
};

/** 這張訂單要不要放退貨這一區:貨已經出去的才有(已出貨、已完成)。其他狀態不必問伺服器。 */
export function showsReturnRequest(orderStatus: string): boolean {
  return RETURNABLE_ORDER_STATUSES.includes(orderStatus as OrderStatus);
}

/** 送什麼:沒給 value 是查看(能不能申請、已經有的退貨),給了是申請。 */
export function returnRequestBody(order: ReturnRequestOrder, value?: ReturnRequestValue): Record<string, unknown> {
  const who = { orderNo: order.orderNo, ...(order.email !== undefined ? { email: order.email } : {}) };
  if (!value) return { action: "status", ...who };
  const note = value.note?.trim();
  return { action: "request", ...who, lines: value.lines, reason: value.reason, ...(note ? { note } : {}) };
}

type ReturnableLine = CustomerReturnView["lines"][number];

/** 表單一開始的件數:只有一項商品時先帶可以退的件數(最常見),多項時由客人挑。 */
export function defaultReturnQty(lines: readonly ReturnableLine[]): Record<string, number> {
  return Object.fromEntries(lines.map((line) => [line.productId, lines.length === 1 ? line.returnable : 0]));
}

/** 表單填的件數 → 要送的品項:只留挑了的,整數,不超過能退的。 */
export function pickedLines(lines: readonly ReturnableLine[], qty: Readonly<Record<string, number>>): ReturnRequestValue["lines"] {
  return lines
    .map((line) => ({ productId: line.productId, qty: Math.min(line.returnable, Math.trunc(Number(qty[line.productId]) || 0)) }))
    .filter((line) => line.qty > 0);
}

const ERRORS: Readonly<Record<string, string>> = {
  not_found: "找不到這筆訂單，請重新整理後再試。",
  invalid_input: "請選擇要退的商品和件數。",
  closed: "這張訂單目前不能申請退貨，請聯絡店家。",
  window_passed: "已超過申請退貨的期限。",
  order_not_returnable: "這張訂單還沒出貨，不能申請退貨。",
  order_closed: "這張訂單已取消，不能申請退貨。",
  // 這兩種之後畫面會照新的件數重畫;可能已經一件都不能退了,所以不說「請重新選擇」。
  qty_exceeds: "可以退的件數變了，請再確認一次。",
  changed: "可以退的件數變了，請再確認一次。",
  rate_limited: "嘗試次數過多，請稍後再試。",
  not_ready: "目前不能申請退貨，請聯絡店家。",
  network: "連線失敗，請再試一次。",
};

const FALLBACK = "申請沒有送出，請再試一次。";

/** 伺服器的錯誤碼 → 給客人看的一句話;不認得的用同一句。 */
export function explainReturnRequestError(code: unknown): string {
  return typeof code === "string" ? (ERRORS[code] ?? FALLBACK) : FALLBACK;
}

const STALE: ReadonlySet<string> = new Set(["qty_exceeds", "changed", "closed", "window_passed", "order_not_returnable", "order_closed"]);

/**
 * 畫面上的東西已經對不上了(件數被別的退貨占走、剛好過了期限、店家關掉了):要重新拿一次能不能申請、能退什麼。
 * 連線失敗、太頻繁、少填這些不算,表單留著讓客人再送一次。
 */
export function isStaleReturnError(code: string): boolean {
  return STALE.has(code);
}

export type ReturnRequestReply =
  | { ok: true; view: CustomerReturnView; returnNo?: string }
  | { ok: false; error: string };

/** 送一次(查看或申請)。 */
export async function callReturnRequest(body: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<ReturnRequestReply> {
  let res: Response;
  try {
    res = await fetcher(RETURN_REQUEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: unknown; error?: unknown; view?: CustomerReturnView; returnNo?: unknown }
    | null;
  if (res.ok && data?.ok === true && data.view) {
    return { ok: true, view: data.view, ...(typeof data.returnNo === "string" ? { returnNo: data.returnNo } : {}) };
  }
  return { ok: false, error: typeof data?.error === "string" ? data.error : "server_error" };
}
