"use client";

import type { ReactNode } from "react";
import type { ManualInstructionLine } from "@/ext/capabilities";
import type { TransferReportSpec } from "@/ext/payment-kit/report-spec";
import { CODE } from "./checkout-styles";
import { TransferReportForm } from "./TransferReportForm";

// 結帳的結局頁(匯款):付款指示 + 回報匯款(0.9.0 從 CheckoutView 拆出來)。

/** 匯款指示(銀行、帳號、金額、訂單編號…):值是會換行的長代碼,窄螢幕不會撐出卡片。 */
export function InstructionLines({ lines }: { lines: ManualInstructionLine[] }) {
  return (
    <dl className="mt-4 space-y-2.5">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline gap-3">
          <dt className="w-20 shrink-0 text-[12.5px] text-black/60">{line.label}</dt>
          <dd className={`${CODE} min-w-0 text-[14px] text-black/85`}>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ManualOrder {
  orderNo: string;
  instructions: ManualInstructionLine[];
  note?: string;
  /** 下單時填的 Email(訪客回報的憑證、給 afterOrder)。 */
  email: string;
}

function intro(asGuest: boolean, managed: boolean, ordersHref: string | null): string {
  if (asGuest || (managed && !ordersHref)) return "訂單已成立，請匯款到以下帳戶：";
  if (managed) return "訂單已成立，請依「我的訂單」顯示的付款期限付款。";
  return "訂單已成立，請於三日內匯款至以下帳戶：";
}

export function ManualResult({
  order,
  spec,
  asGuest,
  managed,
  ordersHref,
  afterOrder,
}: {
  order: ManualOrder;
  /** 收款方式要客人回報什麼(reportSpec)。 */
  spec: TransferReportSpec;
  /** 沒登入、以訪客下的受管訂單(回報用訂單編號 + Email)。 */
  asGuest: boolean;
  managed: boolean;
  /** 客人看自己訂單的頁面;null = 沒有。 */
  ordersHref: string | null;
  afterOrder?: (order: { orderNo: string; email: string }) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <p className="text-[13px] text-black/55">{intro(asGuest, managed, ordersHref)}</p>
        <InstructionLines lines={order.instructions} />
        {order.note ? (
          <p className="mt-4 text-[12.5px] leading-relaxed text-black/60">{order.note}</p>
        ) : null}
      </div>
      <TransferReportForm
        spec={spec}
        orderNo={order.orderNo}
        guestEmail={asGuest ? order.email : undefined}
        ordersHref={ordersHref}
        managed={managed}
      />
      {afterOrder ? afterOrder({ orderNo: order.orderNo, email: order.email }) : null}
    </div>
  );
}
