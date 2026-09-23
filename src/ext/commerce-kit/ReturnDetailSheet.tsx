"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Timeline, type TimelineItem } from "@/components/admin/Timeline";
import { LoadingState } from "@/components/admin/LoadingState";
import { StatusBadge, useStatusSet } from "@/components/admin/StatusBadge";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import { REFUND_METHODS, RETURN_STATUS_SET, refundCap, type ReturnEvent, type ShopReturn } from "./returns";
import {
  RETURN_ACTIONS,
  callReturns,
  cls,
  errorMessage,
  money,
  refundMaxHint,
  type ReturnAction,
  type ReturnDetail,
  type Translate,
} from "./returns-ui";

// 一筆退貨的明細 sheet:內容、下一步、處理紀錄。下一步的欄位跟著選到的動作換:
// 收到退貨 → 每項放回庫存幾件;登記退款 → 金額、方式、備註;其餘只有備註。

function eventDetail(t: Translate, e: ReturnEvent): string {
  const parts: string[] = [];
  if (e.restocked?.length) {
    parts.push(t("returns.event.restocked", { items: e.restocked.map((r) => `${r.name} × ${r.qty}`).join("、") }));
  }
  if (e.refund) parts.push(`${money(e.refund.amount)} · ${t(`returns.method.${e.refund.method}` as MessageKey)}`);
  if (e.note) parts.push(e.note);
  return parts.join(" · ");
}

function toTimeline(t: Translate, events: ReturnEvent[]): TimelineItem[] {
  return events.map((e) => ({
    id: e.id,
    at: e.at,
    title: t(`returns.event.${e.action}` as MessageKey),
    detail: eventDetail(t, e) || undefined,
    actor: e.actorName,
  }));
}

/** 明細:品項、客人、訂單、原因、金額、退款。(export 給渲染測試用) */
export function Summary({ detail, ordersPage }: { detail: ReturnDetail; ordersPage: string }) {
  const t = useT();
  const dates = useDateFormatter();
  const r = detail.return;
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={cls.heading}>{t("returns.items")}</p>
        <ul className="divide-y divide-black/[0.06] admin:divide-ink/[0.06]">
          {r.lines.map((line) => (
            <li key={line.productId} className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px] text-black/85 admin:text-ink/85">
              <span className="min-w-0">
                {line.name} × {line.qty}
                {line.restocked > 0 ? (
                  <span className="ml-2 text-[12px] text-black/45 admin:text-ink/45">
                    {t("returns.restocked", { qty: line.restocked })}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums">{money(line.unitPrice * line.qty)}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className={cls.dl}>
        <dt className={cls.dt}>{t("returns.field.customer")}</dt>
        <dd className={cls.dd}>
          {r.customerName}
          {r.customerPhone ? <span className="ml-2 tabular-nums text-black/55 admin:text-ink/55">{r.customerPhone}</span> : null}
        </dd>
        <dt className={cls.dt}>{t("returns.field.order")}</dt>
        <dd className={cls.dd}>
          <Link href={`${ordersPage}?q=${encodeURIComponent(r.orderNo)}&open=${encodeURIComponent(r.orderNo)}`} className={`${cls.mono} break-all underline decoration-black/20 underline-offset-4 transition-colors hover:decoration-black/60`}>
            {r.orderNo}
          </Link>
          {detail.order ? <span className="ml-2 tabular-nums text-black/45 admin:text-ink/45">{money(detail.order.total)}</span> : null}
        </dd>
        <dt className={cls.dt}>{t("returns.field.reason")}</dt>
        <dd className={cls.dd}>{t(`returns.reason.${r.reason}` as MessageKey)}</dd>
        {r.note ? (
          <>
            <dt className={cls.dt}>{t("returns.field.note")}</dt>
            <dd className={`${cls.dd} whitespace-pre-line`}>{r.note}</dd>
          </>
        ) : null}
        <dt className={cls.dt}>{t("returns.field.requested")}</dt>
        <dd className={`${cls.dd} tabular-nums`}>{money(r.requestedAmount)}</dd>
        {r.refund ? (
          <>
            <dt className={cls.dt}>{t("returns.field.refund")}</dt>
            <dd className={cls.dd}>
              <span className="tabular-nums">{money(r.refund.amount)}</span>
              <span className="text-black/55 admin:text-ink/55"> · {t(`returns.method.${r.refund.method}` as MessageKey)} · {dates.dateTime(r.refund.at)}</span>
              {r.refund.note ? <span className="block text-[12.5px] text-black/55 admin:text-ink/55">{r.refund.note}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>
    </>
  );
}

/** 這一項能放回庫存:有庫存帳,而且這張訂單從庫存扣走過。 */
const restockable = (detail: ReturnDetail, productId: string) =>
  Boolean(detail.stock.tracked[productId] && detail.stock.taken[productId]);

// 放回庫存要店家勾選才做:收回來的東西不一定能再賣(食品、拆封、損壞),放錯了會超賣。
// 勾了之後每項預設全放回,可以逐項改。這張訂單沒扣過庫存的項目不給放回(放回去會
// 憑空多出庫存);一項都不能放回時只說一句,不出現勾選框。
function RestockFields({ detail }: { detail: ReturnDetail }) {
  const t = useT();
  const [on, setOn] = useState(false);
  if (!detail.stock.enabled) return null;
  if (!detail.return.lines.some((line) => restockable(detail, line.productId))) {
    return <p className={cls.hint}>{t("returns.restockNone")}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="inline-flex items-center gap-2 text-[13.5px] text-black/85 admin:text-ink/85">
        <input
          type="checkbox"
          name="restock"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
          className="size-4 accent-(--admin-accent)"
        />
        {t("returns.restockLabel")}
      </label>
      {on ? (
      <ul className="flex flex-col gap-2 pl-6">
        {detail.return.lines.map((line) => (
          <li key={line.productId} className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 text-[13.5px] text-black/85 admin:text-ink/85">
            <span className="min-w-0 truncate">{line.name} × {line.qty}</span>
            {restockable(detail, line.productId) ? (
              <input
                name={`restock:${line.productId}`}
                type="number"
                min={0}
                max={line.qty}
                step={1}
                defaultValue={line.qty}
                inputMode="numeric"
                aria-label={`${t("returns.restockLabel")} ${line.name}`}
                className={`${cls.field} h-9 tabular-nums`}
              />
            ) : (
              <span className="text-[12px] text-black/40 admin:text-ink/40">
                {detail.stock.tracked[line.productId] ? t("returns.notTaken") : t("returns.untracked")}
              </span>
            )}
          </li>
        ))}
      </ul>
      ) : null}
    </div>
  );
}

function RefundFields({ detail }: { detail: ReturnDetail }) {
  const t = useT();
  // 上限:這筆退貨的商品金額加運費,也不超過訂單還沒退的金額(同伺服器的 refundCap)。
  const max = detail.order ? refundCap(detail.order, detail.return.lines) : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className={cls.notice}>{t("returns.refund.notice")}</p>
      <div className="grid grid-cols-2 gap-3">
        <label className={cls.label}>
          {t("returns.refund.amount")}
          <input
            name="amount"
            type="number"
            min={1}
            max={max || undefined}
            step={1}
            required
            inputMode="numeric"
            defaultValue={Math.min(detail.return.requestedAmount, max) || ""}
            className={`${cls.field} tabular-nums`}
          />
        </label>
        <label className={cls.label}>
          {t("returns.refund.method")}
          <select name="method" defaultValue="original" className={cls.field}>
            {REFUND_METHODS.map((m) => (
              <option key={m} value={m}>{t(`returns.method.${m}` as MessageKey)}</option>
            ))}
          </select>
        </label>
      </div>
      <p className={`${cls.hint} -mt-1 tabular-nums`}>
        {detail.order ? refundMaxHint(t, detail.order, detail.return.lines) : t("returns.refund.max", { amount: money(0) })}
      </p>
      <label className={cls.label}>
        {t("returns.refund.note")}
        <input name="refundNote" maxLength={200} placeholder={t("returns.refund.notePlaceholder")} className={cls.field} />
      </label>
    </div>
  );
}

/** FormData → API 的 body。 */
function transitionBody(action: ReturnAction, detail: ReturnDetail, form: FormData) {
  const note = String(form.get("note") ?? "").trim();
  if (action.to === "refunded") {
    const refundNote = String(form.get("refundNote") ?? "").trim();
    return {
      to: action.to,
      refund: { amount: Number(form.get("amount")), method: String(form.get("method")), ...(refundNote ? { note: refundNote } : {}) },
    };
  }
  if (action.to === "received" && detail.stock.enabled && form.get("restock") === "on") {
    const restock = detail.return.lines
      .filter((line) => restockable(detail, line.productId))
      .map((line) => ({ productId: line.productId, qty: Number(form.get(`restock:${line.productId}`) ?? 0) }));
    return { to: action.to, restock, ...(note ? { note } : {}) };
  }
  return { to: action.to, ...(note ? { note } : {}) };
}

/** 下一步:可選的動作與它的欄位。(export 給渲染測試用) */
export function ActionForm({
  detail,
  busy,
  onSubmit,
}: {
  detail: ReturnDetail;
  busy: boolean;
  onSubmit: (action: ReturnAction, form: FormData) => void;
}) {
  const t = useT();
  const actions = RETURN_ACTIONS[detail.return.status];
  const formKey = `${detail.return.returnNo}:${detail.return.status}`;
  const [choice, setChoice] = useState<{ key: string; to: string } | null>(null);
  const selected = actions.find((a) => choice?.key === formKey && a.to === choice.to) ?? actions[0];
  if (!selected) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(selected, new FormData(event.currentTarget));
  };
  return (
    <form key={`${formKey}:${selected.to}`} onSubmit={submit} className={cls.section}>
      <p className={cls.heading}>{t("returns.next")}</p>
      {actions.length > 1 ? (
        <div role="radiogroup" aria-label={t("returns.next")} className="flex flex-wrap gap-1.5">
          {actions.map((a) => {
            const active = a.to === selected.to;
            return (
              <button
                key={a.to}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setChoice({ key: formKey, to: a.to })}
                className={`rounded-full px-3 py-1.5 text-[12.5px] transition-colors duration-150 ${
                  active
                    ? "bg-(--admin-accent)/10 font-medium text-(--admin-accent)"
                    : "text-black/55 admin:text-ink/55 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] hover:bg-black/[0.03] admin:hover:bg-ink/[0.03] hover:text-black/80 admin:hover:text-ink/80"
                }`}
              >
                {t(a.label)}
              </button>
            );
          })}
        </div>
      ) : null}
      {selected.to === "received" ? <RestockFields detail={detail} /> : null}
      {selected.to === "refunded" ? (
        <RefundFields detail={detail} />
      ) : (
        <label className={cls.label}>
          {t("returns.remarks")}
          <input name="note" maxLength={500} className={cls.field} />
        </label>
      )}
      <div className="flex items-center justify-end gap-3 pt-1">
        {selected.final ? <p className={`${cls.hint} mr-auto`}>{t("returns.finalHint")}</p> : null}
        <button type="submit" disabled={busy} className={cls.primary}>
          {busy ? t("returns.submitting") : t(selected.label)}
        </button>
      </div>
    </form>
  );
}

export function ReturnDetailSheet({
  endpoint,
  returnNo,
  statusRef,
  ordersPage,
  canEdit = true,
  onClose,
  onChanged,
}: {
  /** extension API base,如 "/api/ext/shop"。 */
  endpoint: string;
  returnNo: string | null;
  /** 狀態組 `<extId>:returns`。 */
  statusRef: string;
  /** 訂單後台頁(帶 ?q=訂單編號 搜尋)。 */
  ordersPage: string;
  /** 1.52.0:false = 只能看(沒有下一步的表單)。 */
  canEdit?: boolean;
  onClose: () => void;
  onChanged: (updated: ShopReturn) => void;
}) {
  const t = useT();
  const statuses = useStatusSet(statusRef, RETURN_STATUS_SET);
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [reload, setReload] = useState(0);
  // 錯誤存代碼,訊息在 render 時查字典(t 不必進 effect 的相依)。
  const [error, setError] = useState<{ no: string; code: string } | null>(null);
  const [message, setMessage] = useState<{ no: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 打開另一筆(或關了再開)時,上一次的訊息不帶過去。
  const [openedNo, setOpenedNo] = useState(returnNo);
  if (returnNo !== openedNo) {
    setOpenedNo(returnNo);
    if (returnNo) {
      setError(null);
      setMessage(null);
    }
  }

  useEffect(() => {
    if (!returnNo) return;
    let live = true;
    callReturns<ReturnDetail>(`${endpoint}/returns/${encodeURIComponent(returnNo)}`)
      .then((next) => { if (live) setDetail(next); })
      .catch((e: Error) => { if (live) setError({ no: returnNo, code: e.message }); });
    return () => { live = false; };
  }, [endpoint, returnNo, reload]);

  // 關閉動畫期間留著最後一筆;打開另一筆時,新資料到之前先顯示載入中。
  const shown = detail && (!returnNo || detail.return.returnNo === returnNo) ? detail : null;
  const shownNo = returnNo ?? shown?.return.returnNo ?? "";
  const label = (s: string) => statuses[s]?.label ?? s;

  async function submit(action: ReturnAction, form: FormData) {
    if (!shown || busy) return;
    const no = shown.return.returnNo;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await callReturns<{ return: ShopReturn }>(
        `${endpoint}/returns/${encodeURIComponent(no)}/status`,
        transitionBody(action, shown, form),
      );
      setMessage({ no, text: t("returns.updated", { status: label(result.return.status) }) });
      onChanged(result.return);
      setReload((n) => n + 1);
    } catch (e) {
      const code = e instanceof Error ? e.message : "generic";
      setError({ no, code });
      // 狀態被別人改掉了:把最新的明細抓回來,下一步的選項才會對。
      if (code === "changed" || code === "illegal_transition") setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={returnNo !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-mono text-[14px] tracking-normal">{shownNo}</SheetTitle>
          <SheetDescription className="flex items-center gap-2">
            {shown ? <StatusBadge set={statusRef} status={shown.return.status} fallback={RETURN_STATUS_SET} /> : null}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-6 pb-8">
          {error?.no === shownNo ? <p role="alert" className={cls.alert}>{errorMessage(t, error.code)}</p> : null}
          {message?.no === shownNo ? <p role="status" className={cls.notice}>{message.text}</p> : null}
          {shown ? (
            <>
              <Summary detail={shown} ordersPage={ordersPage} />
              {canEdit ? <ActionForm detail={shown} busy={busy} onSubmit={(a, f) => void submit(a, f)} /> : null}
              <div className={cls.section}>
                <p className={cls.heading}>{t("returns.timeline")}</p>
                <Timeline items={toTimeline(t, shown.events)} empty={t("returns.timelineEmpty")} />
              </div>
            </>
          ) : error?.no === shownNo ? null : (
            <LoadingState size="inline" label={t("returns.loading")} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
