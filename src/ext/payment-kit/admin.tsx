import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// payment-kit:金流 extension adminPage 的共用積木(server 端)。
// 樣式常數鏡射 extensions/cron/admin-page.tsx 的 Paper & Ink 慣例 —— 各金流
// extension 以這些積木組頁,保留各自的自由度(狀態列內容依 gateway 而異)。

export const CARD =
  "rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

export const PILL =
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium";
export const PILL_GREEN =
  "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)] shadow-[inset_0_0_0_1px_rgba(16,145,90,0.16)]";
export const PILL_AMBER =
  "bg-amber-500/10 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)]";
export const PILL_RED =
  "bg-red-600/10 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.16)]";
export const PILL_NEUTRAL = "bg-black/[0.04] text-black/55";

export interface PaymentOrderRow {
  order_no: string;
  amount: number;
  description: string;
  status: string;
  trade_no: string | null;
  payment_type: string | null;
  created_at: number;
}

const STATUS_PILL: Record<string, { className: string; label: string }> = {
  paid: { className: PILL_GREEN, label: "已付款" },
  failed: { className: PILL_RED, label: "失敗" },
  pending: { className: PILL_NEUTRAL, label: "待付款" },
};

const TABLE_RE = /^[a-z][a-z0-9_]{2,60}$/;

/** 最近訂單(預設 50 筆)。表尚未建好(啟用瞬間)→ 回空表,別讓整頁炸掉。 */
export async function loadRecentOrders(
  table: string,
  limit = 50,
): Promise<PaymentOrderRow[]> {
  if (!TABLE_RE.test(table)) {
    throw new Error(`[payment-kit] invalid orders table name "${table}"`);
  }
  try {
    return await db().all<PaymentOrderRow>(sql`
      SELECT order_no, amount, description, status, trade_no, payment_type, created_at
      FROM ${sql.raw(table)}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
  } catch {
    return [];
  }
}

export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
      <span className="w-32 shrink-0 text-[12.5px] text-black/45">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-2 text-[13px] text-black/70">
        {children}
      </span>
    </div>
  );
}

export function ConfiguredPill({ configured }: { configured: boolean }) {
  return configured ? (
    <span className={`${PILL} ${PILL_GREEN}`}>已設定</span>
  ) : (
    <span className={`${PILL} ${PILL_RED}`}>未設定</span>
  );
}

/** 訂單一覽表(最近 N 筆)。 */
export function PaymentOrdersTable({ orders }: { orders: PaymentOrderRow[] }) {
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
            <th className="pb-2 pr-4 font-medium">描述</th>
            <th className="pb-2 pr-4 font-medium">交易序號</th>
            <th className="pb-2 font-medium">建立時間</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const pill = STATUS_PILL[o.status] ?? STATUS_PILL.pending;
            return (
              <tr
                key={o.order_no}
                className="border-t border-black/[0.05] text-black/70"
              >
                <td className="py-2.5 pr-4 font-mono text-[12px]">
                  {o.order_no}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  NT$ {o.amount.toLocaleString("zh-TW")}
                </td>
                <td className="py-2.5 pr-4">
                  <span className={`${PILL} ${pill.className}`}>
                    {pill.label}
                  </span>
                </td>
                <td className="max-w-[16rem] truncate py-2.5 pr-4">
                  {o.description}
                </td>
                <td className="py-2.5 pr-4 font-mono text-[12px] text-black/50">
                  {o.trade_no ?? "—"}
                </td>
                <td className="py-2.5 tabular-nums text-[12px] text-black/50">
                  {new Date(o.created_at).toLocaleString("zh-TW", {
                    hour12: false,
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
