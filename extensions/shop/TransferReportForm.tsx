"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  checkTransferReport,
  reportFields,
  REPORT_LIMITS,
  type TransferReportSpec,
} from "@/ext/payment-kit/report-spec";
import { CODE, FIELD, LABEL, PRIMARY_BTN } from "./checkout-styles";
import { reportOnce, sendTransferReport, transferReportRequest } from "./transfer-report";

// 結帳完成頁的回報匯款:在匯款指示底下直接回報。要填哪幾格照收款方式的 reportSpec(0.9.0;預設帳號末五碼),
// 送到哪裡、只送一次在 transfer-report.ts;這裡只有畫面。

/** 回報之後的那一句。 */
export const TRANSFER_REPORTED = "已回報匯款，等店家確認";

export interface TransferReportFormProps {
  spec: TransferReportSpec;
  orderNo: string;
  /** 和回報一起送的下單 Email(見 transfer-report.ts 的 TransferReportOrder.email)。 */
  email?: string;
  /** 以訪客身分下的受管訂單:回報後的字說「查詢訂單」(用訂單編號和 Email),不是「我的訂單」。 */
  guest?: boolean;
  /** 客人看自己訂單的頁面(訂單管理插件給的);null = 沒有這一頁。 */
  ordersHref: string | null;
}

function ReferenceInput({ spec, required }: { spec: TransferReportSpec; required: boolean }) {
  const { label, digits } = spec.reference;
  return (
    <div>
      <label htmlFor="shop-reference" className={LABEL}>
        {label}
      </label>
      <input
        id="shop-reference"
        name="reference"
        className={digits > 0 ? `${FIELD} font-mono` : FIELD}
        {...(digits > 0
          ? { inputMode: "numeric" as const, pattern: `\\d{${digits}}`, maxLength: digits }
          : { maxLength: REPORT_LIMITS.freeText })}
        autoComplete="off"
        required={required}
      />
    </div>
  );
}

function OrdersLink({ href, guest }: { href: string; guest: boolean }) {
  return (
    <Link href={href} className="mx-0.5 underline underline-offset-4">
      {guest ? "訂單查詢" : "我的訂單"}
    </Link>
  );
}

function Later({ orderNo, guest, ordersHref }: { orderNo: string; guest: boolean; ordersHref: string | null }) {
  let text: ReactNode;
  if (!ordersHref) {
    text = <>稍後再匯也可以，請記下訂單編號 <span className={CODE}>{orderNo}</span>。</>;
  } else if (guest) {
    text = (
      <>
        稍後再匯也可以，匯款後到<OrdersLink href={ordersHref} guest />，用訂單編號 <span className={CODE}>{orderNo}</span> 和下單 Email 回報。
      </>
    );
  } else {
    text = <>稍後再匯也可以，匯款後到<OrdersLink href={ordersHref} guest={false} />回報。</>;
  }
  return <p className="text-center text-[12px] text-black/60">{text}</p>;
}

function Reported({ orderNo, guest, ordersHref }: { orderNo: string; guest: boolean; ordersHref: string | null }) {
  return (
    <div role="status" className="text-center">
      <div aria-hidden="true" className="text-[32px]">
        ✓
      </div>
      <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.01em] text-black/85">{TRANSFER_REPORTED}</h2>
      <p className="mt-1.5 text-[13.5px] text-black/60">
        訂單編號 <span className={CODE}>{orderNo}</span>
        {guest && ordersHref ? "，查詢訂單時會用到，請記下來。" : null}
      </p>
      <Link
        href={ordersHref ?? "/"}
        className="mt-6 inline-block text-[13.5px] text-black/70 underline underline-offset-4"
      >
        {!ordersHref ? "返回網站" : guest ? "查詢訂單" : "查看我的訂單"}
      </Link>
    </div>
  );
}

export function TransferReportForm({ spec, orderNo, email, guest = false, ordersHref }: TransferReportFormProps) {
  const fields = reportFields(spec);
  // 送出中再按、送成功之後再按都不會再送(reportOnce)。訂單在這個元件的一生裡不會換。
  const [submit] = useState(() =>
    reportOnce((value) => sendTransferReport(transferReportRequest({ orderNo, email }, value))),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const read = checkTransferReport(spec, {
      reference: String(form.get("reference") ?? ""),
      payerName: String(form.get("payerName") ?? ""),
    });
    if (!read.ok) {
      setError(read.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submit(read.value);
      if (result.ok) setDone(true);
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Reported orderNo={orderNo} guest={guest} ordersHref={ordersHref} />;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3" aria-labelledby="shop-report-title">
      <h2 id="shop-report-title" className="text-[15px] font-semibold tracking-[-0.01em] text-black/85">
        回報匯款
      </h2>
      {fields.reference ? <ReferenceInput spec={spec} required={fields.reference.required} /> : null}
      {fields.payerName ? (
        <div>
          <label htmlFor="shop-payer" className={LABEL}>
            匯款人姓名
          </label>
          <input
            id="shop-payer"
            name="payerName"
            className={FIELD}
            maxLength={REPORT_LIMITS.payerName}
            required={fields.payerName.required}
          />
        </div>
      ) : null}
      {spec.ask === "either" ? <p className="text-[12.5px] text-black/60">填其中一項就可以。</p> : null}
      {error ? (
        <p role="alert" className="text-[13px] text-red-700">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={PRIMARY_BTN}>
        {busy ? "送出中…" : "送出回報"}
      </button>
      <Later orderNo={orderNo} guest={guest} ordersHref={ordersHref} />
    </form>
  );
}
