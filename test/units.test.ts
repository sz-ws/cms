import { describe, expect, it } from "vitest";
import {
  compactNumber,
  CURRENCY_OPTIONS,
  DEFAULT_CURRENCY,
  formatUnit,
  isCurrencyCode,
  normalizeCurrency,
  resolveUnit,
  sameUnit,
} from "../src/lib/units";
import { CORE_SETTINGS } from "../src/lib/settings";

// 1.62.0:數字的單位(儀表板上插件的卡片、報表的圖)。

describe("writing a number for its unit", () => {
  it("count: grouped for the admin language, decimals kept", () => {
    expect(formatUnit(12345.5, { kind: "count" }, "en")).toBe("12,345.5");
    expect(formatUnit(12345, { kind: "count" }, "zh-Hant")).toBe("12,345");
    expect(formatUnit(-3, { kind: "count" }, "en")).toBe("-3");
  });

  it("currency with a code: en symbols, a space, no decimals on whole amounts", () => {
    expect(formatUnit(1500, { kind: "currency", code: "TWD" }, "zh-Hant")).toBe("NT$ 1,500");
    expect(formatUnit(0, { kind: "currency", code: "TWD" }, "en")).toBe("NT$ 0");
    expect(formatUnit(12.5, { kind: "currency", code: "USD" }, "zh-Hant")).toBe("$ 12.50");
    expect(formatUnit(3000.4, { kind: "currency", code: "JPY" }, "en")).toBe("¥ 3,000");
    expect(formatUnit(-21, { kind: "currency", code: "TWD" }, "en")).toBe("-NT$ 21");
  });

  it("currency without a code uses the site currency, TWD when none is given", () => {
    expect(formatUnit(1500, { kind: "currency" }, "en", "USD")).toBe("$ 1,500");
    expect(formatUnit(1500, { kind: "currency" }, "en")).toBe("NT$ 1,500");
    expect(DEFAULT_CURRENCY).toBe("TWD");
    expect(resolveUnit({ kind: "currency" }, "JPY")).toEqual({ kind: "currency", code: "JPY" });
    expect(resolveUnit({ kind: "currency", code: "USD" }, "JPY")).toEqual({ kind: "currency", code: "USD" });
    expect(resolveUnit({ kind: "count" }, "JPY")).toEqual({ kind: "count" });
  });

  it("quantity: the localized label after the number, at most the given decimals", () => {
    const points = { kind: "quantity" as const, label: { "zh-Hant": "點", en: "pts" }, decimals: 4 };
    expect(formatUnit(1.5, points, "zh-Hant")).toBe("1.5 點");
    expect(formatUnit(1.23456, points, "en")).toBe("1.2346 pts");
    expect(formatUnit(3.7, { kind: "quantity", label: "筆" }, "zh-Hant")).toBe("4 筆");
  });

  it("percent: the value is the percentage, one decimal at most", () => {
    expect(formatUnit(12.5, { kind: "percent" }, "en")).toBe("12.5%");
    expect(formatUnit(33.333, { kind: "percent" }, "zh-Hant")).toBe("33.3%");
  });

  it("axis numbers are short", () => {
    expect(compactNumber(12000, "en")).toBe("12K");
    expect(compactNumber(12000, "zh-Hant")).toBe("1.2萬");
  });
});

describe("currency codes", () => {
  it("accepts ISO 4217 codes the runtime knows, and nothing else", () => {
    expect(isCurrencyCode("TWD")).toBe(true);
    expect(isCurrencyCode("usd")).toBe(false);
    expect(isCurrencyCode("NT$")).toBe(false);
    expect(isCurrencyCode("NTD")).toBe(false);
    expect(isCurrencyCode(5)).toBe(false);
    expect(normalizeCurrency("nope")).toBe("TWD");
    expect(normalizeCurrency("EUR")).toBe("EUR");
    // 設定裡存成小寫的幣別照樣認得。
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency(5)).toBe("TWD");
  });

  it("the site currency is a core setting that defaults to TWD, so existing sites do not change", () => {
    const setting = CORE_SETTINGS.find((field) => field.key === "core.currency");
    expect(setting).toMatchObject({ type: "select", default: "TWD", group: "general" });
    expect(CURRENCY_OPTIONS.every((option) => isCurrencyCode(option.value))).toBe(true);
  });
});

describe("comparing units", () => {
  it("is structural", () => {
    expect(sameUnit({ kind: "currency" }, { kind: "currency" })).toBe(true);
    expect(sameUnit({ kind: "currency" }, { kind: "currency", code: "TWD" })).toBe(false);
    expect(sameUnit({ kind: "quantity", label: { en: "pts" } }, { kind: "quantity", label: { en: "pts" }, decimals: 0 })).toBe(true);
    expect(sameUnit({ kind: "quantity", label: "點" }, { kind: "quantity", label: "件" })).toBe(false);
    // 名字照每種語言比:key 的順序不影響,每種語言都一樣的純字串與物件是同一個。
    expect(sameUnit({ kind: "quantity", label: { en: "pts", "zh-Hant": "點" } }, { kind: "quantity", label: { "zh-Hant": "點", en: "pts" } })).toBe(true);
    expect(sameUnit({ kind: "quantity", label: "點" }, { kind: "quantity", label: { "zh-Hant": "點", en: "點" } })).toBe(true);
    expect(sameUnit({ kind: "quantity", label: { en: "pts", "zh-Hant": "點" } }, { kind: "quantity", label: { en: "pts", "zh-Hant": "分" } })).toBe(false);
    expect(sameUnit({ kind: "count" }, { kind: "percent" })).toBe(false);
  });
});
