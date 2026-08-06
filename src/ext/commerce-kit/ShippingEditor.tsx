"use client";

import { useMemo, useState } from "react";
import {
  computeShippingOptions,
  type ShippingConfig,
  type ShippingMethod,
  type ShippingRule,
} from "./shipping-engine";

// commerce-kit:運費設定編輯器(client)。設計目標(Suko 2026-08-06):
//   flexible —— 方式/規則全部後台可改、規則可排序(順序即優先序)、隨存隨生效。
//   visually clear —— 規則以「當…就…」的人話句型呈現;右側**即時試算**面板
//   用同一個 computeShippingOptions 純函式,改任何欄位馬上看到每個配送方式
//   算出來的運費 —— 店家不用腦內模擬規則疊加。
// 依 payment-kit 慣例:client 元件不進 index.ts barrel。

const FIELD =
  "h-9 rounded-[8px] bg-white px-2.5 text-[13px] text-black/85 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] outline-none " +
  "focus:shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.6)]";
const LABEL = "mb-1 block text-[12px] text-black/50";
const CARD_CLS =
  "rounded-[14px] bg-white px-5 py-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06)," +
  "0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";
const GHOST_BTN =
  "rounded-[8px] px-2.5 py-1.5 text-[12.5px] text-black/60 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] hover:bg-black/[0.04] " +
  "disabled:opacity-35";

type EffectType = ShippingRule["effect"]["type"];

function num(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** 規則的人話摘要(顯示在規則列標頭,店家掃一眼就懂)。 */
function ruleSummary(rule: ShippingRule): string {
  const conds: string[] = [];
  const w = rule.when;
  if (w.minSubtotal !== undefined) conds.push(`滿 ${w.minSubtotal}`);
  if (w.maxSubtotal !== undefined) conds.push(`不超過 ${w.maxSubtotal}`);
  if (w.minQty !== undefined) conds.push(`≥ ${w.minQty} 件`);
  if (w.maxQty !== undefined) conds.push(`≤ ${w.maxQty} 件`);
  if (w.regions?.length) conds.push(`寄往 ${w.regions.join("、")}`);
  const scope = w.methods?.length ? `限 ${w.methods.join("、")}:` : "";
  const cond = conds.length > 0 ? `當 ${conds.join(" 且 ")}` : "所有訂單";
  const effect =
    rule.effect.type === "free"
      ? "免運"
      : rule.effect.type === "add"
        ? rule.effect.amount >= 0
          ? `加收 ${rule.effect.amount}`
          : `折抵 ${-rule.effect.amount}`
        : `運費改為 ${rule.effect.amount}`;
  return `${scope}${cond} → ${effect}`;
}

export function ShippingEditor({
  endpoint,
  initial,
}: {
  /** extension API base(如 "/api/ext/shop")。 */
  endpoint: string;
  initial: ShippingConfig | null;
}) {
  const [methods, setMethods] = useState<ShippingMethod[]>(initial?.methods ?? []);
  const [rules, setRules] = useState<ShippingRule[]>(initial?.rules ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 試算面板輸入。
  const [trySubtotal, setTrySubtotal] = useState(1000);
  const [tryQty, setTryQty] = useState(1);
  const [tryRegion, setTryRegion] = useState("");

  const config: ShippingConfig = useMemo(
    () => ({ methods, rules }),
    [methods, rules],
  );
  const preview = useMemo(() => {
    const enabled = methods.filter((m) => m.enabled && m.id && m.name);
    if (enabled.length === 0) return [];
    return computeShippingOptions(
      { subtotal: trySubtotal, qty: tryQty, region: tryRegion.trim() || undefined },
      { methods: enabled, rules },
    );
  }, [methods, rules, trySubtotal, tryQty, tryRegion]);

  function patchMethod(i: number, patch: Partial<ShippingMethod>) {
    setMethods((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }
  function patchRule(i: number, patch: Partial<ShippingRule>) {
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function patchWhen(i: number, patch: Partial<ShippingRule["when"]>) {
    setRules((prev) =>
      prev.map((r, j) => (j === i ? { ...r, when: { ...r.when, ...patch } } : r)),
    );
  }
  function moveRule(i: number, dir: -1 | 1) {
    setRules((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${endpoint}/shipping-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setNotice(data.ok ? "已儲存。" : `儲存失敗:${data.error ?? res.status}`);
    } catch {
      setNotice("網路錯誤,請重試。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="flex min-w-0 flex-col gap-5">
        {/* 配送方式 */}
        <section className={CARD_CLS}>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold text-black/85">配送方式</h2>
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() =>
                setMethods((prev) => [
                  ...prev,
                  { id: `m${prev.length + 1}`, name: "", base: 0, enabled: true },
                ])
              }
            >
              + 新增方式
            </button>
          </div>
          {methods.length === 0 ? (
            <p className="text-[13px] text-black/45">
              尚未設定 —— 沒有配送方式時,結帳不會出現運費(數位商品/自取店家可留空)。
            </p>
          ) : (
            <ul className="space-y-2">
              {methods.map((m, i) => (
                <li key={i} className="flex flex-wrap items-end gap-2.5">
                  <div className="w-36">
                    <label className={LABEL}>名稱</label>
                    <input
                      className={`${FIELD} w-full`}
                      value={m.name}
                      maxLength={40}
                      placeholder="宅配"
                      onChange={(e) => patchMethod(i, { name: e.target.value })}
                    />
                  </div>
                  <div className="w-28">
                    <label className={LABEL}>代號</label>
                    <input
                      className={`${FIELD} w-full font-mono`}
                      value={m.id}
                      maxLength={40}
                      placeholder="home"
                      onChange={(e) => patchMethod(i, { id: e.target.value.trim() })}
                    />
                  </div>
                  <div className="w-28">
                    <label className={LABEL}>基本運費</label>
                    <input
                      className={`${FIELD} w-full tabular-nums`}
                      inputMode="numeric"
                      value={String(m.base)}
                      onChange={(e) => patchMethod(i, { base: num(e.target.value) ?? 0 })}
                    />
                  </div>
                  <label className="flex h-9 items-center gap-1.5 text-[12.5px] text-black/60">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) => patchMethod(i, { enabled: e.target.checked })}
                    />
                    啟用
                  </label>
                  <button
                    type="button"
                    className={GHOST_BTN}
                    onClick={() => setMethods((prev) => prev.filter((_, j) => j !== i))}
                  >
                    刪除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 規則 */}
        <section className={CARD_CLS}>
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold text-black/85">運費規則</h2>
            <button
              type="button"
              className={GHOST_BTN}
              onClick={() =>
                setRules((prev) => [
                  ...prev,
                  { name: "", enabled: true, when: {}, effect: { type: "free" } },
                ])
              }
            >
              + 新增規則
            </button>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-black/45">
            由上往下逐條套用,順序就是優先序;「免運」命中後不再套用後面的規則。
            條件留空 = 不限。
          </p>
          {rules.length === 0 ? (
            <p className="text-[13px] text-black/45">沒有規則 —— 一律收基本運費。</p>
          ) : (
            <ul className="space-y-3">
              {rules.map((r, i) => (
                <li
                  key={i}
                  className="rounded-[10px] bg-black/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
                >
                  <div className="mb-2.5 flex items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-black/[0.07] text-[11px] tabular-nums text-black/55">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-black/75">
                      {ruleSummary(r)}
                    </span>
                    <button type="button" className={GHOST_BTN} disabled={i === 0} onClick={() => moveRule(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className={GHOST_BTN}
                      disabled={i === rules.length - 1}
                      onClick={() => moveRule(i, 1)}
                    >
                      ↓
                    </button>
                    <label className="flex items-center gap-1.5 text-[12.5px] text-black/60">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => patchRule(i, { enabled: e.target.checked })}
                      />
                      啟用
                    </label>
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                    >
                      刪除
                    </button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2.5">
                    <div className="w-40">
                      <label className={LABEL}>規則名稱(客人看得到)</label>
                      <input
                        className={`${FIELD} w-full`}
                        value={r.name}
                        maxLength={40}
                        placeholder="滿千免運"
                        onChange={(e) => patchRule(i, { name: e.target.value })}
                      />
                    </div>
                    <div className="w-24">
                      <label className={LABEL}>滿(小計 ≥)</label>
                      <input
                        className={`${FIELD} w-full tabular-nums`}
                        inputMode="numeric"
                        value={r.when.minSubtotal ?? ""}
                        onChange={(e) => patchWhen(i, { minSubtotal: num(e.target.value) })}
                      />
                    </div>
                    <div className="w-24">
                      <label className={LABEL}>件數 ≥</label>
                      <input
                        className={`${FIELD} w-full tabular-nums`}
                        inputMode="numeric"
                        value={r.when.minQty ?? ""}
                        onChange={(e) => patchWhen(i, { minQty: num(e.target.value) })}
                      />
                    </div>
                    <div className="w-44">
                      <label className={LABEL}>限地區(頓號分隔)</label>
                      <input
                        className={`${FIELD} w-full`}
                        value={r.when.regions?.join("、") ?? ""}
                        placeholder="澎湖縣、金門縣"
                        onChange={(e) => {
                          const list = e.target.value
                            .split(/[、,,\s]+/)
                            .map((s) => s.trim())
                            .filter(Boolean);
                          patchWhen(i, { regions: list.length > 0 ? list : undefined });
                        }}
                      />
                    </div>
                    <div>
                      <label className={LABEL}>限配送方式</label>
                      <div className="flex h-9 items-center gap-2.5">
                        {methods.filter((m) => m.id).map((m) => {
                          const active = r.when.methods?.includes(m.id) ?? false;
                          return (
                            <label
                              key={m.id}
                              className="flex items-center gap-1 text-[12.5px] text-black/60"
                            >
                              <input
                                type="checkbox"
                                checked={active}
                                onChange={(e) => {
                                  const cur = r.when.methods ?? [];
                                  const next = e.target.checked
                                    ? [...cur, m.id]
                                    : cur.filter((x) => x !== m.id);
                                  patchWhen(i, {
                                    methods: next.length > 0 ? next : undefined,
                                  });
                                }}
                              />
                              {m.name || m.id}
                            </label>
                          );
                        })}
                        {methods.length === 0 ? (
                          <span className="text-[12px] text-black/35">(不限)</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="w-32">
                      <label className={LABEL}>效果</label>
                      <select
                        className={`${FIELD} w-full`}
                        value={r.effect.type}
                        onChange={(e) => {
                          const type = e.target.value as EffectType;
                          patchRule(i, {
                            effect:
                              type === "free" ? { type } : { type, amount: 0 },
                          });
                        }}
                      >
                        <option value="free">免運</option>
                        <option value="add">加收/折抵</option>
                        <option value="override">改為固定</option>
                      </select>
                    </div>
                    {r.effect.type !== "free" ? (
                      <div className="w-28">
                        <label className={LABEL}>
                          {r.effect.type === "add" ? "金額(負 = 折抵)" : "固定運費"}
                        </label>
                        <input
                          className={`${FIELD} w-full tabular-nums`}
                          inputMode="numeric"
                          value={String(r.effect.amount)}
                          onChange={(e) => {
                            const amount = num(e.target.value) ?? 0;
                            patchRule(i, { effect: { type: r.effect.type as "add" | "override", amount } });
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="grid h-10 place-items-center rounded-[10px] bg-black px-6 text-[13.5px] font-medium text-white hover:bg-black/85 disabled:opacity-50"
          >
            {busy ? "儲存中…" : "儲存運費設定"}
          </button>
          {notice ? <p className="text-[13px] text-black/55">{notice}</p> : null}
        </div>
      </div>

      {/* 即時試算 —— 與結帳同一個純函式,所見即所得。 */}
      <aside className={`${CARD_CLS} h-fit lg:sticky lg:top-6`}>
        <h2 className="text-[14px] font-semibold text-black/85">試算</h2>
        <p className="mt-0.5 text-[12px] text-black/45">
          改左邊任何欄位,這裡立刻重算 —— 跟結帳頁用同一套規則。
        </p>
        <div className="mt-3 space-y-2.5">
          <div>
            <label className={LABEL}>小計</label>
            <input
              className={`${FIELD} w-full tabular-nums`}
              inputMode="numeric"
              value={String(trySubtotal)}
              onChange={(e) => setTrySubtotal(num(e.target.value) ?? 0)}
            />
          </div>
          <div>
            <label className={LABEL}>件數</label>
            <input
              className={`${FIELD} w-full tabular-nums`}
              inputMode="numeric"
              value={String(tryQty)}
              onChange={(e) => setTryQty(num(e.target.value) ?? 1)}
            />
          </div>
          <div>
            <label className={LABEL}>地區</label>
            <input
              className={`${FIELD} w-full`}
              value={tryRegion}
              placeholder="澎湖縣"
              onChange={(e) => setTryRegion(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 border-t border-black/[0.08] pt-3">
          {preview.length === 0 ? (
            <p className="text-[12.5px] text-black/40">沒有啟用中的配送方式。</p>
          ) : (
            <ul className="space-y-2">
              {preview.map((o) => (
                <li key={o.id} className="text-[13px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-black/70">{o.name}</span>
                    <span className="font-semibold tabular-nums text-black/85">
                      {o.fee === 0 ? "免運" : `NT$ ${o.fee.toLocaleString("zh-TW")}`}
                    </span>
                  </div>
                  {o.applied.length > 0 ? (
                    <p className="text-[11.5px] text-black/40">
                      套用:{o.applied.join("、")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
