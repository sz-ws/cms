"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderStatus } from "./types";

// commerce-kit:訂單動作按鈕(client)。依狀態顯示可做的事,POST 到 shop
// extension 的 admin API 後 router.refresh()。
// 忙碌狀態為靜態文字(無 pulsing / 呼吸動效 —— 專案紅線)。

const BTN =
  "rounded-[8px] px-2.5 py-1 text-[12px] font-medium shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] " +
  "text-black/70 hover:bg-black/[0.04] disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-[8px] bg-black px-2.5 py-1 text-[12px] font-medium text-white " +
  "hover:bg-black/85 disabled:opacity-50";

interface ActionDef {
  label: string;
  primary?: boolean;
  path: (orderNo: string) => string;
  body: Record<string, unknown>;
  confirm?: string;
}

// 匯款訂單專屬:客人沒回報末五碼也能直接入帳(台灣無 open banking,到帳與否
// 只有店家看得到 —— 狀態切換是人工一級公民,不以客人回報為前提)。
const MARK_PAID: ActionDef = {
  label: "標記已收款",
  primary: true,
  path: (n) => `orders/${n}/verify`,
  body: { approve: true },
  confirm: "客人尚未回報末五碼。確認銀行已入帳,直接標記為已付款?",
};

const ACTIONS: Partial<Record<OrderStatus, ActionDef[]>> = {
  awaiting_verify: [
    {
      label: "核可入帳",
      primary: true,
      path: (n) => `orders/${n}/verify`,
      body: { approve: true },
      confirm: "確認已對到這筆匯款?核可後訂單將標記為已付款。",
    },
    {
      label: "退回",
      path: (n) => `orders/${n}/verify`,
      body: { approve: false },
      confirm: "退回後訂單回到待付款,客人可重新回報。",
    },
  ],
  paid: [
    {
      label: "標記出貨",
      primary: true,
      path: (n) => `orders/${n}/status`,
      body: { to: "shipped" },
    },
  ],
  shipped: [
    {
      label: "標記完成",
      path: (n) => `orders/${n}/status`,
      body: { to: "completed" },
    },
  ],
  pending_payment: [
    {
      label: "取消訂單",
      path: (n) => `orders/${n}/status`,
      body: { to: "cancelled" },
      confirm: "取消後不可復原,確定取消這筆訂單?",
    },
  ],
};

export function OrderActions({
  endpoint,
  orderNo,
  status,
  directPaid = false,
}: {
  /** extension API base,如 "/api/ext/shop"。 */
  endpoint: string;
  orderNo: string;
  status: OrderStatus;
  /** true = 這是匯款訂單:pending_payment 額外給「標記已收款」(直接核帳)。 */
  directPaid?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = ACTIONS[status] ?? [];
  const actions =
    directPaid && status === "pending_payment" ? [MARK_PAID, ...base] : base;
  if (actions.length === 0) return null;

  async function run(action: ActionDef) {
    if (busy) return;
    if (action.confirm && !window.confirm(action.confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}/${action.path(orderNo)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(data.error ?? "failed");
        return;
      }
      router.refresh();
    } catch {
      setError("網路錯誤");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          onClick={() => void run(a)}
          className={a.primary ? BTN_PRIMARY : BTN}
        >
          {busy ? "處理中…" : a.label}
        </button>
      ))}
      {error ? (
        <span className="text-[11px] text-red-700">{error}</span>
      ) : null}
    </span>
  );
}
