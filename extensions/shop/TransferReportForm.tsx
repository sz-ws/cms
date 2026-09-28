"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { CODE, FIELD, LABEL, PRIMARY_BTN } from "./checkout-styles";
import {
  readTransferReport,
  reportOnce,
  sendTransferReport,
  transferReportFields,
  transferReportRequest,
  type TransferReportMode,
} from "./transfer-report";

// 結帳完成頁的回報匯款(shop 0.8.0,受管訂單):在匯款指示底下直接回報,欄位照受管訂單那一邊的設定。
// 規則、送到哪裡、只送一次都在 transfer-report.ts;這裡只有畫面。回報之後和「我的訂單」看到的是同一句。

/** 回報之後的那一句:和受管訂單那一邊給客人看的狀態相同(「已回報匯款，等店家確認」)。 */
export const TRANSFER_REPORTED = "已回報匯款，等店家確認";

const ORDERS_HREF = "/shop/orders";

export interface TransferReportFormProps {
  mode: TransferReportMode;
  orderNo: string;
  /** 訪客:下單時填的 Email(和訂單查詢同一組憑證)。已登入的會員不給。 */
  guestEmail?: string;
}

export function TransferReportForm({ mode, orderNo, guestEmail }: TransferReportFormProps) {
  const guest = guestEmail !== undefined;
  const fields = transferReportFields(mode);
  // 送出中再按、送成功之後再按都不會再送(reportOnce)。訂單在這個元件的一生裡不會換。
  const [submit] = useState(() =>
    reportOnce((value) => sendTransferReport(transferReportRequest({ orderNo, guestEmail }, value))),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const read = readTransferReport(mode, {
      last5: String(form.get("last5") ?? ""),
      name: String(form.get("name") ?? ""),
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

  const ordersLink = (
    <Link href={ORDERS_HREF} className="mx-0.5 underline underline-offset-4">
      {guest ? "訂單查詢" : "我的訂單"}
    </Link>
  );
  if (done) {
    return (
      <div role="status" className="text-center">
        <div aria-hidden="true" className="text-[32px]">
          ✓
        </div>
        <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.01em] text-black/85">
          {TRANSFER_REPORTED}
        </h2>
        <p className="mt-1.5 text-[13.5px] text-black/60">
          訂單編號 <span className={CODE}>{orderNo}</span>
          {guest ? "，查詢訂單時會用到，請記下來。" : null}
        </p>
        <Link
          href={ORDERS_HREF}
          className="mt-6 inline-block text-[13.5px] text-black/70 underline underline-offset-4"
        >
          {guest ? "查詢訂單" : "查看我的訂單"}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3" aria-labelledby="shop-report-title">
      <h2 id="shop-report-title" className="text-[15px] font-semibold tracking-[-0.01em] text-black/85">
        回報匯款
      </h2>
      {fields.last5 ? (
        <div>
          <label htmlFor="shop-last5" className={LABEL}>
            已匯款帳號末五碼
          </label>
          <input
            id="shop-last5"
            name="last5"
            className={`${FIELD} font-mono`}
            inputMode="numeric"
            pattern="\d{5}"
            maxLength={5}
            autoComplete="off"
            required={fields.last5.required}
          />
        </div>
      ) : null}
      {fields.name ? (
        <div>
          <label htmlFor="shop-payer" className={LABEL}>
            匯款人姓名
          </label>
          <input
            id="shop-payer"
            name="name"
            className={FIELD}
            maxLength={50}
            required={fields.name.required}
          />
        </div>
      ) : null}
      {mode === "either" ? <p className="text-[12.5px] text-black/60">填其中一項就可以。</p> : null}
      {error ? (
        <p role="alert" className="text-[13px] text-red-700">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={PRIMARY_BTN}>
        {busy ? "送出中…" : "送出回報"}
      </button>
      <p className="text-center text-[12px] text-black/60">
        {guest ? (
          <>
            稍後再匯也可以，匯款後到{ordersLink}，用訂單編號 <span className={CODE}>{orderNo}</span> 和下單 Email 回報。
          </>
        ) : (
          <>稍後再匯也可以，匯款後到{ordersLink}回報。</>
        )}
      </p>
    </form>
  );
}
