import { db } from "@/lib/db";
import {
  CARD,
  PILL,
  PILL_AMBER,
  PILL_GREEN,
  PILL_NEUTRAL,
  PILL_RED,
} from "../payment-kit/admin";
import { countByStatus, listOrders } from "./orders";
import type { CommerceOrder, OrderStatus } from "./types";
import { OrderActions } from "./OrderActions";

// commerce-kit:商店 extension adminPage 的共用積木(server 端)。
// 樣式常數沿用 payment-kit/admin(同一套 Paper & Ink 慣例)—— commerce 本來就
// 依賴 payment capability,不另抄一份避免走樣。
// client 動作按鈕(核帳/出貨…)在 OrderActions.tsx,依 payment-kit 慣例**不**進
// index.ts barrel(server 引擎與 "use client" 元件不共用 barrel)。

export { CARD, PILL, PILL_AMBER, PILL_GREEN, PILL_NEUTRAL, PILL_RED };

/** admin 頁的訂單載入(@/lib/db 直取,不經 services)。表未建好 → 空陣列。 */
export async function loadOrders(
  table: string,
  opts: { status?: OrderStatus; limit?: number } = {},
): Promise<CommerceOrder[]> {
  try {
    return await listOrders({ db: db() }, table, opts);
  } catch {
    return [];
  }
}

/** 各狀態訂單數(佇列 badge)。表未建好 → 空物件(countByStatus 已防禦)。 */
export async function loadStatusCounts(
  table: string,
): Promise<Partial<Record<OrderStatus, number>>> {
  return countByStatus({ db: db() }, table);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "待付款",
  awaiting_verify: "待對帳",
  paid: "已付款",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
};

const ORDER_STATUS_PILL: Record<OrderStatus, string> = {
  pending_payment: PILL_NEUTRAL,
  awaiting_verify: PILL_AMBER,
  paid: PILL_GREEN,
  shipped: PILL_GREEN,
  completed: PILL_NEUTRAL,
  cancelled: PILL_RED,
  refunded: PILL_RED,
};

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  return (
    <span className={`${PILL} ${ORDER_STATUS_PILL[status]}`}>
      {ORDER_STATUS_LABEL[status]}
    </span>
  );
}

function linesSummary(order: CommerceOrder): string {
  if (order.lines.length === 0) return "—";
  const count = order.lines.reduce((n, l) => n + l.qty, 0);
  const first = order.lines[0].name;
  return order.lines.length === 1 && count === 1 ? first : `${first} 等 ${count} 件`;
}

/**
 * 訂單一覽表。actionsEndpoint = 該 extension 的 API base
 * (如 "/api/ext/shop"),給動作按鈕組 POST URL;省略 = 唯讀表。
 */
export function CommerceOrdersTable({
  orders,
  actionsEndpoint,
  transferProvider,
}: {
  orders: CommerceOrder[];
  actionsEndpoint?: string;
  /** 匯款 providerId(ext.<id>.transferProvider)。命中的 pending_payment 列會多
   *  「標記已收款」—— 台灣無 open banking,admin 直接切換狀態是常態動線。 */
  transferProvider?: string;
}) {
  if (orders.length === 0) {
    return <p className="text-[13px] text-black/45">尚無訂單。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="text-[12px] text-black/45">
            <th className="pb-2 pr-4 font-medium">訂單編號</th>
            <th className="pb-2 pr-4 font-medium">金額</th>
            <th className="pb-2 pr-4 font-medium">狀態</th>
            <th className="pb-2 pr-4 font-medium">內容</th>
            <th className="pb-2 pr-4 font-medium">訂購人</th>
            <th className="pb-2 pr-4 font-medium">付款方式</th>
            <th className="pb-2 pr-4 font-medium">建立時間</th>
            {actionsEndpoint ? <th className="pb-2 font-medium">動作</th> : null}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr
              key={o.orderNo}
              className="border-t border-black/[0.05] text-black/70"
            >
              <td className="py-2.5 pr-4 font-mono text-[12px]">{o.orderNo}</td>
              <td className="py-2.5 pr-4 tabular-nums">
                NT$ {o.amounts.total.toLocaleString("zh-TW")}
              </td>
              <td className="py-2.5 pr-4">
                <OrderStatusPill status={o.status} />
              </td>
              <td className="max-w-[14rem] truncate py-2.5 pr-4">
                {linesSummary(o)}
              </td>
              <td className="max-w-[10rem] truncate py-2.5 pr-4">
                {o.customerName}
                <span className="block truncate text-[11px] text-black/40">
                  {o.customerEmail}
                </span>
              </td>
              <td className="py-2.5 pr-4 font-mono text-[12px] text-black/50">
                {o.paymentProvider}
              </td>
              <td className="py-2.5 pr-4 tabular-nums text-[12px] text-black/50">
                {new Date(o.createdAt).toLocaleString("zh-TW", { hour12: false })}
              </td>
              {actionsEndpoint ? (
                <td className="py-2.5">
                  <OrderActions
                    endpoint={actionsEndpoint}
                    orderNo={o.orderNo}
                    status={o.status}
                    directPaid={
                      transferProvider !== undefined &&
                      o.paymentProvider === transferProvider
                    }
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 對帳佇列:匯款訂單列表 + 回報末五碼 + 動作。
 * 兩種用法:awaiting_verify(核可/退回)與 pending_payment + directPaid
 * (等待匯款、客人未回報 —— admin 對到帳直接「標記已收款」)。
 */
export function TransferVerifyQueue({
  orders,
  actionsEndpoint,
  directPaid = false,
  emptyText = "目前沒有待對帳的匯款。",
}: {
  orders: CommerceOrder[];
  actionsEndpoint: string;
  directPaid?: boolean;
  emptyText?: string;
}) {
  if (orders.length === 0) {
    return <p className="text-[13px] text-black/45">{emptyText}</p>;
  }
  return (
    <ul className="space-y-3">
      {orders.map((o) => (
        <li key={o.orderNo} className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[13px] text-black/80">
                  {o.orderNo}
                </span>
                <span className="tabular-nums text-[13px] text-black/70">
                  NT$ {o.amounts.total.toLocaleString("zh-TW")}
                </span>
                <span className="text-[12.5px] text-black/55">
                  末五碼{" "}
                  <span className="font-mono text-black/80">
                    {o.transferLast5 ?? "未回報"}
                  </span>
                </span>
              </div>
              <p className="mt-1 truncate text-[12px] text-black/45">
                {o.customerName} · {o.customerEmail}
                {o.transferReportedAt
                  ? ` · 回報於 ${new Date(o.transferReportedAt).toLocaleString(
                      "zh-TW",
                      { hour12: false },
                    )}`
                  : ""}
              </p>
            </div>
            <OrderActions
              endpoint={actionsEndpoint}
              orderNo={o.orderNo}
              status={o.status}
              directPaid={directPaid}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
