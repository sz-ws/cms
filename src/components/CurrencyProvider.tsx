"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_CURRENCY, formatUnit } from "@/lib/units";

// 1.63.0:client 端的站台幣別(core.currency,規則見 lib/units.ts)。同 1.41.0 的時區
// (DateTimeProvider):root layout 讀一次包在最外層,後台與前台的 client component 都拿得到;
// server component 放 <MoneyText>,不必自己讀設定。

const CurrencyContext = createContext<string | null>(null);

export function CurrencyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

/** 站台幣別(ISO 4217,如 "TWD")。沒有 provider 時是 DEFAULT_CURRENCY。 */
export function useSiteCurrency(): string {
  return useContext(CurrencyContext) ?? DEFAULT_CURRENCY;
}

/** 一個金額,照站台幣別寫(NT$ 1,200)。server component 也能直接放:<MoneyText amount={order.total} />。 */
export function MoneyText({ amount }: { amount: number }) {
  return <>{formatUnit(amount, { kind: "currency" }, "zh-Hant", useSiteCurrency())}</>;
}
