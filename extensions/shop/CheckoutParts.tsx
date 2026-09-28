"use client";

import type { PublicCheckoutField } from "@/ext/commerce-kit/checkout-fields";
import type { ShippingOption } from "@/ext/commerce-kit/shipping-engine";
import type { CartItem } from "./cart-store";
import { CODE, FIELD, LABEL } from "./checkout-styles";

// 結帳表單的幾塊畫面(0.9.0 從 CheckoutView 拆出來)。狀態都在 CheckoutView,這裡只畫。

export interface AppliedPromo {
  code: string;
  label: string;
  discount: number;
  freeShipping: boolean;
}

type Money = (amount: number) => string;

const CARD =
  "rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";
const CHOICE = (active: boolean) =>
  active ? "bg-black text-white" : "bg-white text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]";

/** 訂單摘要:品項、小計、優惠碼、運費、合計。 */
export function OrderSummary({
  items,
  subtotal,
  promo,
  shipping,
  total,
  money,
}: {
  items: readonly CartItem[];
  subtotal: number;
  promo: AppliedPromo | null;
  shipping: { name: string; fee: number } | null;
  total: number;
  money: Money;
}) {
  return (
    <div className={CARD}>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.productId} className="flex justify-between gap-3 text-[13.5px]">
            <span className="min-w-0 truncate text-black/70">
              {i.name} × {i.qty}
            </span>
            <span className="shrink-0 tabular-nums text-black/80">{money(i.unitPrice * i.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1.5 border-t border-black/[0.08] pt-3 text-[13.5px]">
        <div className="flex justify-between">
          <span className="text-black/55">小計</span>
          <span className="tabular-nums text-black/80">{money(subtotal)}</span>
        </div>
        {promo ? (
          <div className="flex justify-between gap-3">
            <span className="min-w-0 text-black/55">
              優惠碼 <span className={CODE}>{promo.code}</span>
            </span>
            <span className="shrink-0 tabular-nums text-emerald-700">
              {promo.discount > 0 ? `− ${money(promo.discount)}` : "免運"}
            </span>
          </div>
        ) : null}
        {shipping ? (
          <div className="flex justify-between">
            <span className="text-black/55">運費（{shipping.name}）</span>
            <span className="tabular-nums text-black/80">{shipping.fee === 0 ? "免運" : money(shipping.fee)}</span>
          </div>
        ) : null}
        <div className="flex justify-between pt-1 text-[14.5px]">
          <span className="text-black/55">合計</span>
          <span className="font-semibold tabular-nums text-black/85">{money(total)}</span>
        </div>
      </div>
    </div>
  );
}

/** 配送方式:整排列出,客人挑 —— 每個選項的運費已套完規則。 */
export function ShippingChoices({
  options,
  selected,
  onSelect,
  money,
}: {
  options: readonly ShippingOption[];
  selected: string | null;
  onSelect: (id: string) => void;
  money: Money;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset>
      <legend className={LABEL}>配送方式</legend>
      <div className="flex flex-col gap-2">
        {options.map((o) => {
          const active = selected === o.id;
          return (
            <label
              key={o.id}
              className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-[10px] px-4 py-3 text-[14px] ${CHOICE(active)}`}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <input
                  type="radio"
                  name="shipping"
                  value={o.id}
                  checked={active}
                  onChange={() => onSelect(o.id)}
                  className="sr-only"
                />
                <span>{o.name}</span>
                {o.applied.length > 0 ? (
                  <span className={`truncate text-[11.5px] ${active ? "text-white/60" : "text-black/60"}`}>
                    {o.applied.join("、")}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums">{o.fee === 0 ? "免運" : money(o.fee)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 優惠碼:輸入後按「套用」試算;套用後可以移除。 */
export function PromoField({
  promo,
  input,
  error,
  busy,
  onInput,
  onApply,
  onRemove,
  money,
}: {
  promo: AppliedPromo | null;
  input: string;
  error: string | null;
  busy: boolean;
  onInput: (value: string) => void;
  onApply: () => void;
  onRemove: () => void;
  money: Money;
}) {
  return (
    <div>
      <label htmlFor="shop-promo" className={LABEL}>
        優惠碼（選填）
      </label>
      {promo ? (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-[10px] bg-emerald-50 px-3.5 py-2 text-[13.5px] text-emerald-800 shadow-[inset_0_0_0_1px_rgba(4,120,87,0.25)]">
          <span className="min-w-0">
            <span className={CODE}>{promo.code}</span> 已套用
            {promo.discount > 0 ? ` — 折 ${money(promo.discount)}` : " — 免運"}
          </span>
          <button type="button" className="shrink-0 text-[12.5px] underline underline-offset-2" onClick={onRemove}>
            移除
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            id="shop-promo"
            className={`${FIELD} flex-1 font-mono uppercase`}
            maxLength={40}
            value={input}
            onChange={(e) => onInput(e.target.value.toUpperCase())}
            placeholder="EXAMPLE10"
          />
          <button
            type="button"
            disabled={busy || input.trim().length < 2}
            onClick={onApply}
            className="h-11 shrink-0 rounded-[10px] px-4 text-[13.5px] text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] hover:bg-black/[0.04] disabled:opacity-40"
          >
            套用
          </button>
        </div>
      )}
      {error ? <p className="mt-1.5 text-[12.5px] text-red-700">{error}</p> : null}
    </div>
  );
}

/** 插件宣告的結帳欄位(commerce-kit checkout-fields)。hidden 的不畫。 */
export function ExtraFields({
  fields,
  values,
  onChange,
}: {
  fields: readonly PublicCheckoutField[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {fields.map((field, index) => {
        if (field.input === "hidden") return null;
        const id = `shop-field-${index}`;
        const common = {
          id,
          name: field.name,
          maxLength: field.maxLength,
          required: field.required,
          value: values[field.name] ?? "",
          autoComplete: "off",
        };
        return (
          <div key={field.name}>
            <label htmlFor={id} className={LABEL}>
              {field.required ? field.label : `${field.label}（選填）`}
            </label>
            {field.input === "textarea" ? (
              <textarea
                {...common}
                className={`${FIELD} h-24 py-2.5 leading-relaxed`}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            ) : (
              <input {...common} className={FIELD} onChange={(e) => onChange(field.name, e.target.value)} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** 付款方式:刷卡、匯款(店家有設定的才出現)。 */
export function PaymentMethods({
  cardEnabled,
  transferEnabled,
  method,
  onSelect,
}: {
  cardEnabled: boolean;
  transferEnabled: boolean;
  method: "card" | "transfer";
  onSelect: (method: "card" | "transfer") => void;
}) {
  const choice = (value: "card" | "transfer", label: string) => (
    <label
      className={`flex-1 cursor-pointer rounded-[10px] px-4 py-3 text-center text-[14px] ${CHOICE(method === value)}`}
    >
      <input
        type="radio"
        name="method"
        value={value}
        checked={method === value}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      {label}
    </label>
  );
  return (
    <fieldset>
      <legend className={LABEL}>付款方式</legend>
      <div className="flex gap-2">
        {cardEnabled ? choice("card", "線上刷卡") : null}
        {transferEnabled ? choice("transfer", "銀行轉帳") : null}
      </div>
    </fieldset>
  );
}
