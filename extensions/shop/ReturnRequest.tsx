"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { RETURN_REASONS, type CustomerReturnView, type ReturnReason } from "@/ext/commerce-kit/returns";
import { FIELD, LABEL } from "./checkout-styles";
import {
  CUSTOMER_REASON_LABELS,
  CUSTOMER_RETURN_LABELS,
  callReturnRequest,
  defaultReturnQty,
  explainReturnRequestError,
  isStaleReturnError,
  pickedLines,
  returnRequestBody,
  showsReturnRequest,
  type ReturnRequestValue,
} from "./return-request";

// 客人的訂單上「退貨」這一區:這張訂單的退貨與進度,以及(店家開放、還在期限內時)一顆「申請退貨」。
// 畫訂單的頁面只要放 <ReturnRequest orderNo status email? />:該不該出現、能退什麼、期限,都是伺服器
// 說了算(return-request.ts → commerce-kit 的 returns-customer.ts)。店家沒開放、或這張訂單沒有東西可說時
// 什麼都不畫。沒有金額的欄位:退多少由店家決定。
//
// 樣式是結帳頁那組中性的黑白 utility;放進別的頁面時用 classes 換成那一頁的欄位與按鈕。

export interface ReturnRequestClasses {
  field: string;
  label: string;
  primary: string;
  quiet: string;
}

// 兩顆按鈕並排在右下(結帳頁那顆滿版的主按鈕放在這裡太重)。
const BUTTON = "inline-flex h-10 items-center justify-center rounded-[10px] px-4 text-[13.5px] font-medium disabled:opacity-50";
const DEFAULT_CLASSES: ReturnRequestClasses = {
  field: FIELD,
  label: LABEL,
  primary: `${BUTTON} bg-black text-white hover:bg-black/85`,
  quiet: `${BUTTON} bg-white text-black/75 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] hover:bg-black/[0.03]`,
};

/** 申請送出之後的那一句。 */
export const RETURN_ASKED = "已送出退貨申請，您可以在這張訂單查看進度。";
const PICK_ITEMS = "請選擇要退的商品和件數。";

const HINT = "text-[12.5px] text-black/55";

function Requests({ returns }: { returns: CustomerReturnView["returns"] }) {
  const dates = useDateFormatter("zh-Hant");
  return (
    <div className="flex flex-col gap-1.5">
      <p className={HINT}>退貨申請</p>
      <ul className="flex flex-col gap-2">
        {returns.map((r) => (
          <li key={r.returnNo} className="flex flex-col gap-0.5 text-[13.5px] text-black/85">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">{r.lines.map((line) => `${line.name} × ${line.qty}`).join("、")}</span>
              <span className="shrink-0 font-medium">{CUSTOMER_RETURN_LABELS[r.status]}</span>
            </span>
            <span className={`${HINT} tabular-nums`}>
              {dates.date(r.createdAt)} 申請 · <span className="font-mono">{r.returnNo}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FormProps {
  view: CustomerReturnView;
  busy: boolean;
  error?: string;
  classes: ReturnRequestClasses;
  onCancel: () => void;
  onSubmit: (value: ReturnRequestValue) => void;
}

function RequestForm({ view, busy, error, classes, onCancel, onSubmit }: FormProps) {
  const id = useId();
  const initial = defaultReturnQty(view.lines);
  // 少選了商品的那一句寫在按鈕上面;改了欄位就收掉。
  const [problem, setProblem] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const qty = Object.fromEntries(view.lines.map((line) => [line.productId, Number(form.get(`qty:${line.productId}`))]));
    const lines = pickedLines(view.lines, qty);
    if (lines.length === 0) {
      setProblem(PICK_ITEMS);
      return;
    }
    setProblem("");
    onSubmit({ lines, reason: String(form.get("reason")) as ReturnReason, note: String(form.get("note") ?? "") });
  }

  const shown = problem || error;
  return (
    <form onSubmit={submit} onInput={() => setProblem("")} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {view.lines.map((line) => (
          <li key={line.productId} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
            <label htmlFor={`${id}-${line.productId}`} className="min-w-0 text-[13.5px] text-black/85">
              <span className="block [overflow-wrap:anywhere]">{line.name}</span>
              <span className={`${HINT} tabular-nums`}>最多 {line.returnable} 件</span>
            </label>
            <input
              id={`${id}-${line.productId}`}
              name={`qty:${line.productId}`}
              type="number"
              min={0}
              max={line.returnable}
              step={1}
              inputMode="numeric"
              defaultValue={initial[line.productId]}
              className={`${classes.field} mt-0! tabular-nums`}
            />
          </li>
        ))}
      </ul>
      <div>
        <label htmlFor={`${id}-reason`} className={classes.label}>原因</label>
        <select id={`${id}-reason`} name="reason" defaultValue={RETURN_REASONS[0]} className={classes.field}>
          {RETURN_REASONS.map((reason) => (
            <option key={reason} value={reason}>{CUSTOMER_REASON_LABELS[reason]}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className={classes.label}>說明（選填）</label>
        <textarea
          id={`${id}-note`}
          name="note"
          rows={3}
          maxLength={500}
          placeholder="例如：收到時外盒破損"
          className={`${classes.field} h-auto! min-h-[4.5rem] py-2 leading-relaxed`}
        />
      </div>
      <p className={HINT}>送出後要等店家同意，退款金額由店家決定。</p>
      {shown ? <p role="alert" className="text-[13px] text-red-700">{shown}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={classes.quiet} disabled={busy} onClick={onCancel}>先不要</button>
        <button type="submit" className={classes.primary} disabled={busy}>{busy ? "送出中…" : "送出申請"}</button>
      </div>
    </form>
  );
}

export interface ReturnRequestViewProps {
  view: CustomerReturnView;
  /** 按了「申請退貨」,表單開著。 */
  asking: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  classes?: Partial<ReturnRequestClasses>;
  /** 這一區最外層的樣式(卡片、分隔線)。沒有東西可畫時整區不出現,所以外框要交給這裡,不要在外面包一層。 */
  className?: string;
  onAsk: () => void;
  onCancel: () => void;
  onSubmit: (value: ReturnRequestValue) => void;
}

/** 照伺服器回的 view 畫;沒有東西可說時回 null。(export 給渲染測試用) */
export function ReturnRequestView({ view, asking, busy, error, notice, classes, className, onAsk, onCancel, onSubmit }: ReturnRequestViewProps) {
  const dates = useDateFormatter("zh-Hant");
  const look = { ...DEFAULT_CLASSES, ...classes };
  const late = !view.open && view.blocked === "window_passed" && view.deadline !== null;
  if (!view.open && view.returns.length === 0 && !late) return null;
  return (
    <section aria-label="退貨" className={`flex flex-col gap-3${className ? ` ${className}` : ""}`}>
      {view.returns.length > 0 ? <Requests returns={view.returns} /> : null}
      {notice ? <p role="status" className="text-[13px] text-black/70">{notice}</p> : null}
      {/* 表單開著時錯誤寫在它的按鈕上面;表單收起來了(例如剛好都被申請走了)就寫在這裡。 */}
      {error && !(view.open && asking) ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
      {view.open && !asking ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {view.deadline !== null ? <p className={`${HINT} tabular-nums`}>{dates.dateTime(view.deadline)} 前可以申請。</p> : null}
          <button type="button" className={look.quiet} onClick={onAsk}>申請退貨</button>
        </div>
      ) : null}
      {view.open && asking ? <RequestForm view={view} busy={busy} error={error} classes={look} onCancel={onCancel} onSubmit={onSubmit} /> : null}
      {late && view.deadline !== null ? <p className={`${HINT} tabular-nums`}>已超過申請退貨的期限（{dates.dateTime(view.deadline)}）。</p> : null}
    </section>
  );
}

export interface ReturnRequestProps {
  orderNo: string;
  /** 訂單狀態。不是已出貨、已完成就什麼都不畫,也不問伺服器。 */
  status: string;
  /** 訪客:查單用的下單 Email,每一次都一起送。已登入的會員不帶。 */
  email?: string;
  classes?: Partial<ReturnRequestClasses>;
  /** 這一區最外層的樣式(見 ReturnRequestViewProps.className)。 */
  className?: string;
}

/** 換一張訂單時呼叫端換 key,回到還沒按「申請退貨」。 */
export function ReturnRequest({ orderNo, status, email, classes, className }: ReturnRequestProps) {
  const wanted = showsReturnRequest(status);
  const [loaded, setLoaded] = useState<{ orderNo: string; view: CustomerReturnView } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sending = useRef(false);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void callReturnRequest(returnRequestBody({ orderNo, email })).then((reply) => {
      // 問不到(連線、太頻繁)就不畫這一區:沒開放的店本來就什麼都沒有,不為了它多一句錯誤。
      if (live && reply.ok) setLoaded({ orderNo, view: reply.view });
    });
    return () => { live = false; };
  }, [wanted, orderNo, email]);

  const view = wanted && loaded?.orderNo === orderNo ? loaded.view : null;
  if (!view) return null;

  async function submit(value: ReturnRequestValue) {
    // 送出中再按一次不會再送(只退一部分件數時,連按兩下會變成兩筆申請)。
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = await callReturnRequest(returnRequestBody({ orderNo, email }, value));
      if (reply.ok) {
        setLoaded({ orderNo, view: reply.view });
        setAsking(false);
        setNotice(RETURN_ASKED);
        return;
      }
      setError(explainReturnRequestError(reply.error));
      // 畫面上的已經對不上了:重新拿一次,表單照新的件數畫(不能申請了就收起來,錯誤留在這一區)。
      if (isStaleReturnError(reply.error)) {
        const fresh = await callReturnRequest(returnRequestBody({ orderNo, email }));
        if (fresh.ok) setLoaded({ orderNo, view: fresh.view });
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <ReturnRequestView
      // 能退的件數變了,表單從頭開始(件數的預設值跟著新的數字)。
      key={view.lines.map((line) => `${line.productId}:${line.returnable}`).join(",")}
      view={view}
      asking={asking}
      busy={busy}
      error={error}
      notice={notice}
      classes={classes}
      className={className}
      onAsk={() => { setAsking(true); setNotice(""); setError(""); }}
      onCancel={() => { setAsking(false); setError(""); }}
      onSubmit={(value) => void submit(value)}
    />
  );
}
