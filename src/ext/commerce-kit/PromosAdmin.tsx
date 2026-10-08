"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSiteCurrency } from "@/components/CurrencyProvider";
import { useDateFormatter } from "@/components/DateTimeProvider";
import { SlotRegion } from "@/components/SlotRegion";
import { TIME_ZONE_OPTIONS } from "@/lib/datetime";
import type { SlotParts } from "@/ext/slots";
import type { Promo, PromoType } from "./promo";
import { promoEffect } from "./promo-effect";
import { PROMO_FIELD as FIELD, PROMO_HINT, PROMO_LABEL as LABEL, PromoFormProvider, type PromoAfterSave, type PromoFormState } from "./promo-form";
import { EMPTY_PROMO_FORM, formToBody, promoToForm, type PromoFormValues } from "./promo-form-state";
import { promoPeriodState, type PromoPeriodState } from "./promo-window";
import { formatMoney } from "./money";

// commerce-kit:優惠碼管理(client)。列表 + 建立/編輯表單。
// 用量(used)只顯示不可編 —— 要重置就刪掉重建(promo.ts upsert 不動 used)。
//
// 開始與結束:表單上每一端是日期與時間兩格,照站台時區(promo-window.ts);列表寫出期間。
// 表單裡有一個插槽(core-slots.ts 的 AdminPromoFormFields):別的插件在這裡多放一格跟這個優惠碼有關的欄位,
// 用 promo-form.tsx 的 usePromoForm() 知道表單上的代碼,並登記存好之後要一起做的事。

const GHOST_BTN =
  "rounded-[8px] admin:rounded-[calc(8px*var(--admin-radius-scale,1))] px-2.5 py-1.5 text-[12.5px] text-black/60 admin:text-ink/60 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] hover:bg-black/[0.04] admin:hover:bg-ink/[0.04] " +
  "disabled:opacity-35";

/** 列表「狀態」那一格:現在用不用得了。 */
const STATE_TEXT: Record<PromoPeriodState, string> = {
  active: "啟用中",
  disabled: "停用",
  scheduled: "尚未開始",
  expired: "已過期",
  used_up: "已用完",
};

/** 期間的寫法:只有開始「…起」、只有結束「到…」、都有「… – …」;都沒有是 null。 */
function periodText(promo: Pick<Promo, "startsAt" | "endsAt">, format: (ms: number) => string): string | null {
  if (promo.startsAt === null && promo.endsAt === null) return null;
  if (promo.endsAt === null) return `${format(promo.startsAt!)} 起`;
  if (promo.startsAt === null) return `到 ${format(promo.endsAt)}`;
  return `${format(promo.startsAt)} – ${format(promo.endsAt)}`;
}

export function PromosAdmin({
  endpoint,
  promos,
  readOnly = false,
  now,
  formFields,
}: {
  /** extension API base(如 "/api/ext/shop")。 */
  endpoint: string;
  promos: Promo[];
  /** 1.52.0:只能看的角色(canEditCurrentPage())—— 只列優惠碼,不畫建立表單與編輯、刪除。 */
  readOnly?: boolean;
  /** 伺服器畫這一頁的時間(epoch ms):列表據此分出尚未開始、已過期、已用完。沒給就只分啟用與停用。 */
  now?: number;
  /** 表單插槽的內容(伺服器元件 `await slotParts(AdminPromoFormFields, {})` 的結果);沒給就沒有額外的欄位。 */
  formFields?: SlotParts;
}) {
  const router = useRouter();
  const currency = useSiteCurrency();
  const dates = useDateFormatter("zh-Hant");
  const timeZone = dates.timeZone;
  const [form, setForm] = useState<PromoFormValues>(EMPTY_PROMO_FORM);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 插槽裡的欄位登記的「存好之後要做的事」(promo-form.tsx 的 afterSave)。
  const afterSaveHandlers = useRef(new Set<PromoAfterSave>());
  const formCode = form.code.trim().toUpperCase();
  const formState = useMemo<PromoFormState>(
    () => ({
      code: formCode,
      editing,
      busy,
      afterSave: (handler) => {
        afterSaveHandlers.current.add(handler);
        return () => {
          afterSaveHandlers.current.delete(handler);
        };
      },
    }),
    [formCode, editing, busy],
  );
  const zoneName = TIME_ZONE_OPTIONS.find((option) => option.value === timeZone)?.label["zh-Hant"] ?? timeZone;

  function patch(p: Partial<PromoFormValues>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  /** 送一個請求;回傳要顯示的錯誤,成功是 null。 */
  async function send(path: string, body: unknown): Promise<string | null> {
    try {
      const res = await fetch(`${endpoint}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      return data.ok ? null : `失敗：${data.error ?? res.status}`;
    } catch {
      return "網路錯誤，請重試。";
    }
  }

  async function post(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const failed = await send(path, body);
      if (failed) setNotice(failed);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** 插槽裡的欄位登記的事,依序做;沒做成的各回一句話。一個出錯不擋其他的。 */
  async function runAfterSave(code: string): Promise<string[]> {
    const problems: string[] = [];
    for (const handler of [...afterSaveHandlers.current]) {
      try {
        const problem = await handler(code);
        if (problem) problems.push(problem);
      } catch {
        problems.push("有一項設定沒有存成功，請重新整理後再確認。");
      }
    }
    return problems;
  }

  async function save() {
    const checked = formToBody(form, timeZone);
    if (!checked.ok) {
      setNotice(checked.message);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const failed = await send("promos/save", checked.body);
      if (failed) {
        setNotice(failed);
        return;
      }
      const problems = await runAfterSave(checked.body.code);
      router.refresh();
      setForm(EMPTY_PROMO_FORM);
      setEditing(false);
      setNotice(["已儲存。", ...problems].join(""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 建立/編輯 */}
      {readOnly ? null : (
        <section className="rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-white admin:bg-surface px-5 py-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]">
          <h2 className="mb-3 text-[14px] font-semibold text-black/85 admin:text-ink/85">
            {editing ? `編輯 ${form.code}` : "建立優惠碼"}
          </h2>
          <div className="flex flex-wrap items-end gap-2.5">
            <div className="w-40">
              <label className={LABEL}>代碼（大寫英數）</label>
              <input
                className={`${FIELD} w-full font-mono uppercase`}
                value={form.code}
                maxLength={40}
                disabled={editing}
                placeholder="EXAMPLE10"
                onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="w-36">
              <label className={LABEL}>名稱（給自己看）</label>
              <input
                className={`${FIELD} w-full`}
                value={form.label}
                maxLength={60}
                onChange={(e) => patch({ label: e.target.value })}
              />
            </div>
            <div className="w-28">
              <label className={LABEL}>類型</label>
              <select
                className={`${FIELD} w-full`}
                value={form.type}
                onChange={(e) => patch({ type: e.target.value as PromoType })}
              >
                <option value="percent">打折（%）</option>
                <option value="flat">折抵（元）</option>
                <option value="freeship">免運</option>
              </select>
            </div>
            {form.type !== "freeship" ? (
              <div className="w-24">
                <label className={LABEL}>
                  {form.type === "percent" ? "折扣 %（1–100）" : "折抵金額"}
                </label>
                <input
                  className={`${FIELD} w-full tabular-nums`}
                  inputMode="numeric"
                  value={String(form.value)}
                  onChange={(e) => patch({ value: Number(e.target.value) || 0 })}
                />
              </div>
            ) : null}
            <div className="w-24">
              <label className={LABEL}>低消（0 = 不限）</label>
              <input
                className={`${FIELD} w-full tabular-nums`}
                inputMode="numeric"
                value={String(form.minSubtotal)}
                onChange={(e) => patch({ minSubtotal: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="w-36">
              <label className={LABEL}>次數上限（空白 = 不限）</label>
              <input
                className={`${FIELD} w-full tabular-nums`}
                inputMode="numeric"
                value={form.maxUses === null ? "" : String(form.maxUses)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  patch({ maxUses: v === "" ? null : Math.max(1, Number(v) || 1) });
                }}
              />
            </div>
            <PeriodEdge
              title="開始（空白 = 不限）"
              name="開始"
              day={form.startDay}
              time={form.startTime}
              onDay={(startDay) => patch({ startDay })}
              onTime={(startTime) => patch({ startTime })}
            />
            <PeriodEdge
              title="結束（空白 = 不限）"
              name="結束"
              day={form.endDay}
              time={form.endTime}
              onDay={(endDay) => patch({ endDay })}
              onTime={(endTime) => patch({ endTime })}
            />
            <PromoFormProvider value={formState}>
              <SlotRegion parts={formFields} />
            </PromoFormProvider>
            <label className="flex h-9 items-center gap-1.5 text-[12.5px] text-black/60 admin:text-ink/60">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              啟用
            </label>
            <button
              type="button"
              disabled={busy || form.code.trim().length < 2}
              onClick={() => void save()}
              className="grid h-9 place-items-center rounded-[10px] admin:rounded-[calc(10px*var(--admin-radius-scale,1))] bg-black admin:bg-ink px-5 text-[13px] font-medium text-white hover:bg-black/85 admin:hover:bg-ink/85 disabled:opacity-50"
            >
              {busy ? "…" : editing ? "更新" : "建立"}
            </button>
            {editing ? (
              <button
                type="button"
                className={GHOST_BTN}
                onClick={() => {
                  setForm(EMPTY_PROMO_FORM);
                  setEditing(false);
                }}
              >
                取消
              </button>
            ) : null}
          </div>
          <p className={`mt-2.5 ${PROMO_HINT}`}>
            只選日期時，開始從當天 00:00 算，結束算到當天 23:59。時間是網站的時區：{zoneName}。
          </p>
          {notice ? <p className="mt-2.5 text-[13px] text-black/55 admin:text-ink/55">{notice}</p> : null}
        </section>
      )}

      {/* 列表 */}
      {promos.length === 0 ? (
        <p className="text-[13px] text-black/45 admin:text-ink/45">還沒有優惠碼。</p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] admin:rounded-[calc(14px*var(--admin-radius-scale,1))] bg-white admin:bg-surface shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] admin:shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-black/[0.08] admin:border-ink/[0.08] text-[12px] text-black/45 admin:text-ink/45">
                <th className="px-4 py-2.5 font-normal">代碼</th>
                <th className="px-3 py-2.5 font-normal">效果</th>
                <th className="px-3 py-2.5 font-normal">低消</th>
                <th className="px-3 py-2.5 font-normal">用量</th>
                <th className="px-3 py-2.5 font-normal">期間</th>
                <th className="px-3 py-2.5 font-normal">狀態</th>
                {readOnly ? null : <th className="px-3 py-2.5 font-normal" />}
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => {
                const state: PromoPeriodState = now === undefined ? (p.enabled ? "active" : "disabled") : promoPeriodState(p, now);
                return (
                  <tr key={p.code} className="border-b border-black/[0.05] admin:border-ink/[0.05] last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-black/85 admin:text-ink/85">{p.code}</span>
                      {p.label ? (
                        <span className="ml-2 text-[12px] text-black/45 admin:text-ink/45">{p.label}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-black/70 admin:text-ink/70">
                      {promoEffect(p, (amount) => formatMoney(amount, currency))}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-black/70 admin:text-ink/70">
                      {p.minSubtotal > 0 ? formatMoney(p.minSubtotal, currency) : "—"}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-black/70 admin:text-ink/70">
                      {p.used}
                      {p.maxUses !== null ? ` / ${p.maxUses}` : ""}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums whitespace-nowrap text-black/70 admin:text-ink/70">
                      {periodText(p, dates.dateTime) ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={
                          state === "active"
                            ? "text-[12px] text-emerald-700"
                            : "text-[12px] text-black/40 admin:text-ink/40"
                        }
                      >
                        {STATE_TEXT[state]}
                      </span>
                    </td>
                    {readOnly ? null : (
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className={GHOST_BTN}
                            onClick={() => {
                              setForm(promoToForm(p, timeZone));
                              setEditing(true);
                              window.scrollTo({ top: 0 });
                            }}
                          >
                            編輯
                          </button>
                          <button
                            type="button"
                            className={GHOST_BTN}
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`刪除優惠碼 ${p.code}？`)) {
                                void post("promos/delete", { code: p.code });
                              }
                            }}
                          >
                            刪除
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 期間的一端:日期與時間兩格。時間可以不填(開始 = 當天 00:00,結束 = 當天最後一刻)。 */
function PeriodEdge({
  title,
  name,
  day,
  time,
  onDay,
  onTime,
}: {
  title: string;
  /** 「開始」或「結束」,組成兩格的名稱(給螢幕報讀)。 */
  name: string;
  day: string;
  time: string;
  onDay: (value: string) => void;
  onTime: (value: string) => void;
}) {
  return (
    <div>
      <span className={LABEL}>{title}</span>
      <div className="flex gap-1.5">
        <input
          type="date"
          aria-label={`${name}日期`}
          className={`${FIELD} w-36 tabular-nums`}
          value={day}
          onChange={(e) => onDay(e.target.value)}
        />
        <input
          type="time"
          aria-label={`${name}時間`}
          className={`${FIELD} w-28 tabular-nums`}
          value={time}
          onChange={(e) => onTime(e.target.value)}
        />
      </div>
    </div>
  );
}
