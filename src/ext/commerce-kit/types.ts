// commerce-kit:商店引擎的型別 + 訂單狀態機(單一事實來源)。
//
// 分工(與 payment-kit 平行的兄弟 kit,docs/spec-commerce-kit.md):
//   - **kit(本資料夾)** 持有商店不變的部分:訂單表讀寫、狀態機、結帳協調
//     (驗商品 → 伺服器計價 → 建單 → 呼叫 payment capability)、匯款回報/核帳
//     流程、admin 積木。
//   - **extension(extensions/shop)** 只持有接線:表名、settings、route 宣告、
//     admin 頁組裝、payment:succeeded hook 綁定。
//
// commerce-kit 與 payment-kit 的邊界:commerce 只說「去收錢」並監聽
// payment:succeeded —— 錢怎麼進來(刷卡加密/人工核帳)全部是 payment 側的事。

/**
 * 訂單狀態。匯款(manual 付款)多出 awaiting_verify 人工閘口;刷卡回呼直接
 * pending_payment → paid。refunded 僅記帳(gateway 退款 API 刻意不做,
 * spec-payment-capability.md §6),cancelled 只允許在收到錢之前。
 */
export type OrderStatus =
  | "pending_payment"
  | "awaiting_verify"
  | "paid"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunded";

/**
 * 合法轉移(from → to[])。這張表是狀態機的**唯一**定義 —— transitionOrder 由它
 * 反查合法來源做條件式 UPDATE,不存在第二份轉移邏輯。
 * 與早前討論的差異(有意):awaiting_verify 核帳退回走 → pending_payment
 * (客人可補匯/重報,比直接 cancelled 寬容);要終止訂單另走 cancelled 動作。
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["awaiting_verify", "paid", "cancelled"],
  awaiting_verify: ["paid", "pending_payment", "cancelled"],
  paid: ["shipped", "refunded"],
  shipped: ["completed"],
  completed: [],
  cancelled: [],
  refunded: [],
};

export const ORDER_STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

export function isOrderStatus(value: string): value is OrderStatus {
  return value in ORDER_TRANSITIONS;
}

/** 可轉移到 `to` 的合法來源狀態(條件式 UPDATE 的 WHERE status IN (...))。 */
export function transitionSources(to: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => ORDER_TRANSITIONS[from].includes(to));
}

/** 訂單品項快照 —— 下單當下凍結(商品之後改價/下架不影響已成立訂單)。 */
export interface OrderLine {
  productId: string;
  name: string;
  /** 單價(整數,最小貨幣單位;TWD 即元)—— 伺服器讀 catalog 計得,永不信 client。 */
  unitPrice: number;
  qty: number;
}

/**
 * 金額拆帳:subtotal − discount + shipping = total。
 * discount/shipping 在 Phase 1–2 恆為 0,欄位先立好 —— 運費規則引擎(Phase 3)與
 * 優惠碼(Phase 4)落地時只動計算,不動表。
 */
export interface OrderAmounts {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
}

/** 訂單列(ext_<id>_orders;欄位契約見 orders.ts 檔頭)。 */
export interface CommerceOrder {
  orderNo: string;
  status: OrderStatus;
  lines: OrderLine[];
  amounts: OrderAmounts;
  /** 收款的 payment providerId(如 "newebpay" / "banktransfer")。 */
  paymentProvider: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  shipAddress: string | null;
  /** 收件地區(縣市;運費規則 regions 條件的比對值快照)。 */
  region: string | null;
  /** 配送方式名稱快照(如「宅配」;fee 在 amounts.shipping)。 */
  shippingMethod: string | null;
  /** 套用的優惠碼(大寫;折抵金額在 amounts.discount)。 */
  promoCode: string | null;
  /** 匯款回報:帳號末五碼 + 回報時間(未回報 = null)。 */
  transferLast5: string | null;
  transferReportedAt: number | null;
  /** 最近一次狀態動作的附註(核帳紀錄等)。 */
  note: string | null;
  createdAt: number;
  updatedAt: number;
}
