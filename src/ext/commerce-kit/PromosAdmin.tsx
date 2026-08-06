"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Promo, PromoType } from "./promo";

// commerce-kit:優惠碼管理(client)。列表 + 建立/編輯表單。
// 用量(used)只顯示不可編 —— 要重置就刪掉重建(promo.ts upsert 不動 used)。

const FIELD =
  "h-9 rounded-[8px] bg-white px-2.5 text-[13px] text-black/85 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] outline-none " +
  "focus:shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.6)]";
const LABEL = "mb-1 block text-[12px] text-black/50";
const GHOST_BTN =
  "rounded-[8px] px-2.5 py-1.5 text-[12.5px] text-black/60 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] hover:bg-black/[0.04] " +
  "disabled:opacity-35";

const TYPE_LABEL: Record<PromoType, string> = {
  percent: "打折",
  flat: "折抵",
  freeship: "免運",
};

function promoEffect(p: Promo): string {
  if (p.type === "percent") return `${p.value}% off`;
  if (p.type === "flat") return `折 NT$ ${p.value.toLocaleString("zh-TW")}`;
  return "免運";
}

interface FormState {
  code: string;
  label: string;
  type: PromoType;
  value: number;
  minSubtotal: number;
  maxUses: number | null;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  code: "",
  label: "",
  type: "percent",
  value: 10,
  minSubtotal: 0,
  maxUses: null,
  enabled: true,
};

export function PromosAdmin({
  endpoint,
  promos,
}: {
  /** extension API base(如 "/api/ext/shop")。 */
  endpoint: string;
  promos: Promo[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function patch(p: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  async function post(path: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${endpoint}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setNotice(`失敗:${data.error ?? res.status}`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setNotice("網路錯誤,請重試。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (await post("promos/save", form)) {
      setForm(EMPTY_FORM);
      setEditing(false);
      setNotice("已儲存。");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 建立/編輯 */}
      <section className="rounded-[14px] bg-white px-5 py-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <h2 className="mb-3 text-[14px] font-semibold text-black/85">
          {editing ? `編輯 ${form.code}` : "建立優惠碼"}
        </h2>
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="w-40">
            <label className={LABEL}>代碼(大寫英數)</label>
            <input
              className={`${FIELD} w-full font-mono uppercase`}
              value={form.code}
              maxLength={40}
              disabled={editing}
              placeholder="WELCOME10"
              onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="w-36">
            <label className={LABEL}>名稱(給自己看)</label>
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
              <option value="percent">打折(%)</option>
              <option value="flat">折抵(元)</option>
              <option value="freeship">免運</option>
            </select>
          </div>
          {form.type !== "freeship" ? (
            <div className="w-24">
              <label className={LABEL}>
                {form.type === "percent" ? "折扣 %(1–100)" : "折抵金額"}
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
            <label className={LABEL}>低消(0 = 不限)</label>
            <input
              className={`${FIELD} w-full tabular-nums`}
              inputMode="numeric"
              value={String(form.minSubtotal)}
              onChange={(e) => patch({ minSubtotal: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="w-28">
            <label className={LABEL}>次數上限(空 = 不限)</label>
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
          <label className="flex h-9 items-center gap-1.5 text-[12.5px] text-black/60">
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
            className="grid h-9 place-items-center rounded-[10px] bg-black px-5 text-[13px] font-medium text-white hover:bg-black/85 disabled:opacity-50"
          >
            {busy ? "…" : editing ? "更新" : "建立"}
          </button>
          {editing ? (
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() => {
                setForm(EMPTY_FORM);
                setEditing(false);
              }}
            >
              取消
            </button>
          ) : null}
        </div>
        {notice ? <p className="mt-2.5 text-[13px] text-black/55">{notice}</p> : null}
      </section>

      {/* 列表 */}
      {promos.length === 0 ? (
        <p className="text-[13px] text-black/45">還沒有優惠碼。</p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-black/[0.08] text-[12px] text-black/45">
                <th className="px-4 py-2.5 font-normal">代碼</th>
                <th className="px-3 py-2.5 font-normal">效果</th>
                <th className="px-3 py-2.5 font-normal">低消</th>
                <th className="px-3 py-2.5 font-normal">用量</th>
                <th className="px-3 py-2.5 font-normal">狀態</th>
                <th className="px-3 py-2.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.code} className="border-b border-black/[0.05] last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-black/85">{p.code}</span>
                    {p.label ? (
                      <span className="ml-2 text-[12px] text-black/45">{p.label}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-black/70">
                    {TYPE_LABEL[p.type]} · {promoEffect(p)}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-black/70">
                    {p.minSubtotal > 0 ? `NT$ ${p.minSubtotal.toLocaleString("zh-TW")}` : "—"}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-black/70">
                    {p.used}
                    {p.maxUses !== null ? ` / ${p.maxUses}` : ""}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={
                        p.enabled
                          ? "text-[12px] text-emerald-700"
                          : "text-[12px] text-black/40"
                      }
                    >
                      {p.enabled ? "啟用中" : "停用"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className={GHOST_BTN}
                        onClick={() => {
                          setForm({
                            code: p.code,
                            label: p.label,
                            type: p.type,
                            value: p.value,
                            minSubtotal: p.minSubtotal,
                            maxUses: p.maxUses,
                            enabled: p.enabled,
                          });
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
                          if (window.confirm(`刪除優惠碼 ${p.code}?`)) {
                            void post("promos/delete", { code: p.code });
                          }
                        }}
                      >
                        刪除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
