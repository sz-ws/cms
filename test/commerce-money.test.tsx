import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMoney } from "../src/ext/commerce-kit/money";
import { currencySymbol } from "../src/lib/units";
import { CurrencyProvider, MoneyText } from "../src/components/CurrencyProvider";

// 1.63.0:商店的金額照站台幣別(core.currency)寫,和儀表板同一套寫法(lib/units.ts)。

describe("formatMoney(amount, currency)", () => {
  it("writes the site currency with the dashboard's rules", () => {
    expect(formatMoney(1200, "TWD")).toBe("NT$ 1,200");
    expect(formatMoney(1200, "USD")).toBe("$ 1,200");
    expect(formatMoney(3000, "JPY")).toBe("¥ 3,000");
    expect(formatMoney(0, "TWD")).toBe("NT$ 0");
  });

  it("without a currency keeps the 1.61.0 behaviour (TWD)", () => {
    expect(formatMoney(1200)).toBe("NT$ 1,200");
  });
});

describe("currencySymbol", () => {
  it("is the symbol formatMoney writes, or the code when the runtime doesn't know it", () => {
    expect(currencySymbol("TWD")).toBe("NT$");
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("nope")).toBe("nope");
  });
});

describe("MoneyText", () => {
  it("follows the provider, and defaults to TWD without one", () => {
    const inUsd = createElement(CurrencyProvider, { currency: "USD" }, createElement(MoneyText, { amount: 1500 }));
    expect(renderToStaticMarkup(inUsd)).toBe("$ 1,500");
    expect(renderToStaticMarkup(createElement(MoneyText, { amount: 1500 }))).toBe("NT$ 1,500");
  });
});
