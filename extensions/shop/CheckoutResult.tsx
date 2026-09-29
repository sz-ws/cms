"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDateFormatter } from "@/components/DateTimeProvider";
import type { ManualInstructionLine } from "@/ext/capabilities";
import type { TransferReportSpec } from "@/ext/payment-kit/report-spec";
import { CODE } from "./checkout-styles";
import { PageHeader } from "./PageHeader";
import { TransferReportForm } from "./TransferReportForm";
import { reportEmailFor } from "./transfer-report";

// 結帳的結局頁(匯款):付款指示 + 回報匯款(0.9.0 從 CheckoutView 拆出來)。
// 0.11.0:這一頁自己畫標題「訂單已成立」(沒有「回購物車」);知道付款期限時寫在付款指示上面;
// 每一行付款指示旁邊有「複製」(照原樣複製那一行的值,不分付款方式)。

type CopyState = "idle" | "copied" | "failed";
const COPY_TEXT: Record<CopyState, string> = { idle: "複製", copied: "已複製", failed: "複製失敗" };
/** 「已複製」「複製失敗」停留多久再變回「複製」。 */
const COPY_RESET_MS = 2000;

/** 複製一行付款指示的值。狀態只換字(沒有動畫);螢幕閱讀器從 aria-live 聽到結果。 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function settle(next: CopyState) {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPY_RESET_MS);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      settle("copied");
    } catch {
      // 不是 https、或瀏覽器不給:值還在畫面上,客人可以自己選取。
      settle("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="shrink-0 rounded-[8px] px-2 py-0.5 text-[12px] text-black/60 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] hover:bg-black/[0.04]"
    >
      <span aria-live="polite">{COPY_TEXT[state]}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

/** 匯款指示(銀行、帳號、金額、訂單編號…):值是會換行的長代碼,窄螢幕不會撐出卡片;每行可以複製。 */
export function InstructionLines({ lines }: { lines: ManualInstructionLine[] }) {
  return (
    <dl className="mt-4 space-y-2.5">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline gap-3">
          <dt className="w-20 shrink-0 text-[12.5px] text-black/60">{line.label}</dt>
          <dd className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
            <span className={`${CODE} min-w-0 text-[14px] text-black/85`}>{line.value}</span>
            <CopyButton value={line.value} label={line.label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ManualOrder {
  orderNo: string;
  instructions: ManualInstructionLine[];
  note?: string;
  /** 下單時填的 Email(回報匯款的憑證、給 afterOrder)。 */
  email: string;
  /** 0.11.0:付款期限(epoch ms,結帳回覆的 expiresAt);沒有 = 不知道(商店自己的訂單、較舊的訂單管理插件)。 */
  expiresAt?: number | null;
}

/** 付款指示上面那一句:知道期限就寫期限;不知道時照以前的說法。 */
function Intro({
  deadline,
  asGuest,
  managed,
  ordersHref,
}: {
  deadline: string | null;
  asGuest: boolean;
  managed: boolean;
  ordersHref: string | null;
}) {
  if (deadline) {
    return (
      <>
        請在 <span className="font-medium tabular-nums text-black/85">{deadline}</span> 前匯款到以下帳戶：
      </>
    );
  }
  if (asGuest || (managed && !ordersHref)) return <>請匯款到以下帳戶：</>;
  if (managed) return <>請到「我的訂單」查看付款期限，並匯款到以下帳戶：</>;
  return <>請於三日內匯款到以下帳戶：</>;
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
  // 付款期限照站台時區寫(和訂單頁、查單頁同一個 formatter)。
  const dates = useDateFormatter("zh-Hant");
  const deadline = order.expiresAt ? dates.dateTime(order.expiresAt) : null;
  // 回報帶下單 Email:商店自己的訂單(core 用它確認是下單的人)與訪客的受管訂單;已登入會員的受管訂單看登入的人。
  const reportEmail = reportEmailFor({ email: order.email, managed, asGuest });
  return (
    <>
      <PageHeader title="訂單已成立" />
      <div className="flex flex-col gap-6">
        <div className="rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <p className="text-[13px] text-black/55">
            <Intro deadline={deadline} asGuest={asGuest} managed={managed} ordersHref={ordersHref} />
          </p>
          <InstructionLines lines={order.instructions} />
          {order.note ? (
            <p className="mt-4 text-[12.5px] leading-relaxed text-black/60">{order.note}</p>
          ) : null}
        </div>
        <TransferReportForm
          spec={spec}
          orderNo={order.orderNo}
          email={reportEmail}
          guest={asGuest}
          ordersHref={ordersHref}
        />
        {afterOrder ? afterOrder({ orderNo: order.orderNo, email: order.email }) : null}
      </div>
    </>
  );
}
