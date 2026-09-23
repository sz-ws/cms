"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingState } from "@/components/admin/LoadingState";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import { RETURN_REASONS, RETURN_STATUS_SET, orderReturnBlock, refundCap, suggestedRefund, type ShopReturn } from "./returns";
import { callReturns, cls, errorMessage, money, refundMaxHint, type OrderLookup } from "./returns-ui";

// 店家代客人建立退貨:輸入訂單編號 → 列出各項可退件數 → 選件數、原因、金額 → 建立。
// 從訂單頁「申請退貨」進來時(?order=)訂單編號已帶好、直接查。

type Lookup = { no: string; data?: OrderLookup; error?: string };

function defaultQty(data: OrderLookup): Record<string, number> {
  const lines = data.order.lines;
  // 只有一項商品時預設全退(最常見);多項時由店家挑。
  return Object.fromEntries(lines.map((l) => [l.productId, lines.length === 1 ? l.returnable : 0]));
}

function OrderLines({
  data,
  qty,
  onQty,
}: {
  data: OrderLookup;
  qty: Record<string, number>;
  onQty: (productId: string, value: number) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium text-black/55 admin:text-ink/55">{t("returns.create.items")}</p>
      <ul className="flex flex-col gap-2">
        {data.order.lines.map((line) => (
          <li key={line.productId} className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
            <span className="min-w-0 text-[13.5px] text-black/85 admin:text-ink/85">
              <span className="block truncate">{line.name}</span>
              <span className="text-[12px] tabular-nums text-black/45 admin:text-ink/45">
                {money(line.unitPrice)} ·{" "}
                {line.returnable > 0
                  ? t("returns.create.returnable", { qty: line.returnable })
                  : t("returns.create.allReturned")}
              </span>
            </span>
            <input
              type="number"
              min={0}
              max={line.returnable}
              step={1}
              inputMode="numeric"
              disabled={line.returnable === 0}
              value={qty[line.productId] ?? 0}
              onChange={(e) => onQty(line.productId, Math.max(0, Math.min(line.returnable, Math.trunc(Number(e.target.value) || 0))))}
              aria-label={line.name}
              className={`${cls.field} h-9 tabular-nums`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderFacts({ data, statusRef, onOpenReturn }: { data: OrderLookup; statusRef: string; onOpenReturn: (no: string) => void }) {
  const t = useT();
  const dates = useDateFormatter();
  const o = data.order;
  return (
    <dl className={cls.dl}>
      <dt className={cls.dt}>{t("returns.field.customer")}</dt>
      <dd className={cls.dd}>
        {o.customerName}
        {o.customerPhone ? <span className="ml-2 tabular-nums text-black/55 admin:text-ink/55">{o.customerPhone}</span> : null}
      </dd>
      <dt className={cls.dt}>{t("returns.field.orderTotal")}</dt>
      <dd className={`${cls.dd} tabular-nums`}>{money(o.total)}</dd>
      {o.discount > 0 ? (
        <>
          <dt className={cls.dt}>{t("returns.field.discount")}</dt>
          <dd className={`${cls.dd} tabular-nums`}>{money(o.discount)}</dd>
        </>
      ) : null}
      <dt className={cls.dt}>{t("returns.field.placedAt")}</dt>
      <dd className={`${cls.dd} tabular-nums`}>{dates.dateTime(o.createdAt)}</dd>
      {o.refunded > 0 ? (
        <>
          <dt className={cls.dt}>{t("returns.field.refunded")}</dt>
          <dd className={`${cls.dd} tabular-nums`}>{money(o.refunded)}</dd>
        </>
      ) : null}
      {o.returns.length > 0 ? (
        <>
          <dt className={cls.dt}>{t("returns.create.existing")}</dt>
          <dd className={`${cls.dd} flex flex-col items-start gap-1`}>
            {o.returns.map((r) => (
              <button key={r.returnNo} type="button" onClick={() => onOpenReturn(r.returnNo)} className="inline-flex items-center gap-2 rounded-[6px] text-left transition-colors hover:text-black admin:hover:text-ink">
                <span className={`${cls.mono} underline decoration-black/20 underline-offset-4`}>{r.returnNo}</span>
                <StatusBadge set={statusRef} status={r.status} fallback={RETURN_STATUS_SET} />
              </button>
            ))}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function ReturnCreateSheet({
  endpoint,
  open,
  initialOrderNo,
  statusRef,
  onClose,
  onCreated,
  onOpenReturn,
}: {
  endpoint: string;
  open: boolean;
  /** 從訂單頁帶進來的訂單編號(打開就查)。 */
  initialOrderNo: string | null;
  statusRef: string;
  onClose: () => void;
  onCreated: (created: ShopReturn) => void;
  onOpenReturn: (returnNo: string) => void;
}) {
  const t = useT();
  const [requested, setRequested] = useState<{ no: string; n: number } | null>(
    initialOrderNo ? { no: initialOrderNo, n: 0 } : null,
  );
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requested) return;
    let live = true;
    callReturns<OrderLookup>(`${endpoint}/returns/order/${encodeURIComponent(requested.no)}`)
      .then((data) => {
        if (!live) return;
        setLookup({ no: requested.no, data });
        setQty(defaultQty(data));
        setAmount(null);
      })
      .catch((e: Error) => { if (live) setLookup({ no: requested.no, error: e.message }); });
    return () => { live = false; };
  }, [endpoint, requested]);

  const looking = requested !== null && lookup?.no !== requested.no;
  const data = !looking && lookup?.data ? lookup.data : null;
  const lookupError = !looking && lookup?.error ? lookup.error : data ? orderReturnBlock(data.order.status) : null;
  // 每一項都已經申請過退貨:不給一張只能送出失敗的表單。
  const nothingLeft = data !== null && data.order.eligible && data.order.lines.every((l) => l.returnable === 0);
  // 預設金額是退回件數的實付價格(扣掉訂單折扣、不含運費);上限是退回這幾件的商品
  // 金額加運費(refundCap,和伺服器同一條規則),不是整張訂單。
  const picked = data ? data.order.lines.map((l) => ({ unitPrice: l.unitPrice, qty: qty[l.productId] ?? 0 })) : [];
  const autoAmount = data ? suggestedRefund(data.order, picked) : 0;
  const amountMax = data ? refundCap(data.order, picked) : 0;
  const amountText = amount ?? String(autoAmount);

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const no = String(new FormData(event.currentTarget).get("orderNo") ?? "").trim();
    if (!no) return;
    setError(null);
    setRequested((prev) => ({ no, n: (prev?.n ?? 0) + 1 }));
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || busy) return;
    const lines = data.order.lines
      .map((l) => ({ productId: l.productId, qty: qty[l.productId] ?? 0 }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) {
      setError(t("returns.create.pickItems"));
      return;
    }
    const form = new FormData(event.currentTarget);
    const note = String(form.get("note") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const result = await callReturns<{ return: ShopReturn }>(`${endpoint}/returns`, {
        orderNo: data.order.orderNo,
        lines,
        reason: String(form.get("reason")),
        requestedAmount: Number(amountText),
        ...(note ? { note } : {}),
      });
      onCreated(result.return);
    } catch (e) {
      setError(errorMessage(t, e instanceof Error ? e.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-[16px] font-semibold tracking-[-0.01em]">{t("returns.new")}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-6 pb-8">
          <form onSubmit={find} className="flex items-end gap-2">
            <label className={`${cls.label} flex-1`}>
              {t("returns.create.orderNo")}
              <input
                name="orderNo"
                defaultValue={initialOrderNo ?? ""}
                required
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                className={`${cls.field} font-mono`}
              />
            </label>
            <button type="submit" disabled={looking} className={cls.quiet.replace("h-9", "h-10")}>
              {looking ? t("returns.create.looking") : t("returns.create.lookup")}
            </button>
          </form>
          {looking ? <LoadingState size="inline" label={t("returns.create.looking")} /> : null}
          {lookupError ? <p role="alert" className={cls.alert}>{errorMessage(t, lookupError)}</p> : null}
          {data ? <OrderFacts data={data} statusRef={statusRef} onOpenReturn={onOpenReturn} /> : null}
          {nothingLeft ? <p role="status" className={cls.notice}>{t("returns.create.nothingLeft")}</p> : null}
          {data?.order.eligible && !nothingLeft ? (
            <form onSubmit={(e) => void create(e)} className={cls.section}>
              <OrderLines data={data} qty={qty} onQty={(id, value) => setQty((prev) => ({ ...prev, [id]: value }))} />
              <label className={cls.label}>
                {t("returns.field.reason")}
                <select name="reason" defaultValue={RETURN_REASONS[0]} className={cls.field}>
                  {RETURN_REASONS.map((r) => (
                    <option key={r} value={r}>{t(`returns.reason.${r}` as MessageKey)}</option>
                  ))}
                </select>
              </label>
              <label className={cls.label}>
                {t("returns.field.note")}
                <textarea name="note" maxLength={500} rows={3} placeholder={t("returns.create.notePlaceholder")} className={cls.area} />
              </label>
              <label className={cls.label}>
                {t("returns.create.amount")}
                <input
                  type="number"
                  min={0}
                  max={amountMax}
                  step={1}
                  required
                  inputMode="numeric"
                  value={amountText}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`${cls.field} tabular-nums`}
                />
                {picked.some((p) => p.qty > 0) ? (
                  <span className={`${cls.hint} font-normal tabular-nums`}>{refundMaxHint(t, data.order, picked)}</span>
                ) : null}
                {data.order.discount > 0 ? (
                  <span className={`${cls.hint} font-normal`}>{t("returns.create.amountDiscounted")}</span>
                ) : null}
              </label>
              {error ? <p role="alert" className={cls.alert}>{error}</p> : null}
              <div className="flex justify-end pt-1">
                <button type="submit" disabled={busy} className={cls.primary}>
                  {busy ? t("returns.submitting") : t("returns.create.submit")}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
