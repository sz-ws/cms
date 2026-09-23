import { describe, it, expect } from "vitest";
import {
  formatPrice,
  httpsUrl,
  isEntitled,
  parseAccess,
  parseOffer,
} from "../src/lib/registry-offer";

// 付費插件協定 1:registry.json 條目的 offer 與 access。不合格的 offer 整筆丟掉;價格一律
// 用 en 語系排版(zh-TW 的 TWD 符號是單獨一個 $,跟美元分不出來)。

describe("formatPrice", () => {
  it("formats with the en locale, no decimals for whole amounts", () => {
    expect(formatPrice({ amount: 25000, currency: "TWD" })).toBe("NT$25,000");
    expect(formatPrice({ amount: 3000, currency: "JPY" })).toBe("¥3,000");
    expect(formatPrice({ amount: 12, currency: "USD" })).toBe("$12");
    expect(formatPrice({ amount: 12.5, currency: "USD" })).toBe("$12.50");
  });
});

describe("parseAccess", () => {
  it("knows the four states and nothing else", () => {
    for (const state of ["granted", "locked", "requested", "expired"]) expect(parseAccess(state)).toBe(state);
    for (const bad of ["Granted", "open", "", null, 1, undefined]) expect(parseAccess(bad)).toBeUndefined();
  });

  it("an entry without access is free; only granted is entitled among the rest", () => {
    expect(isEntitled({})).toBe(true);
    expect(isEntitled({ access: "granted" })).toBe(true);
    expect(isEntitled({ access: "locked" })).toBe(false);
    expect(isEntitled({ access: "requested" })).toBe(false);
    expect(isEntitled({ access: "expired" })).toBe(false);
  });
});

describe("parseOffer", () => {
  const full = {
    price: { amount: 25000, currency: "TWD", period: "year" },
    note: { "zh-Hant": "每站,含設定與一年支援", en: "Per site, setup included" },
    action: "request",
    termsUrl: "https://registry.example.com/terms",
  };

  it("keeps a valid offer", () => {
    expect(parseOffer(full)).toEqual(full);
    expect(parseOffer({ note: "依人數報價" })).toEqual({ note: "依人數報價" });
    expect(parseOffer({ action: "link", url: "https://registry.example.com/buy" })).toEqual({
      action: "link",
      url: "https://registry.example.com/buy",
    });
  });

  it("drops the whole offer when any field is wrong", () => {
    const broken: Record<string, unknown>[] = [
      { ...full, price: { amount: 25000, currency: "twd", period: "year" } },
      { ...full, price: { amount: 25000, currency: "NTD$", period: "year" } },
      { ...full, price: { amount: -1, currency: "TWD", period: "year" } },
      { ...full, price: { amount: "25000", currency: "TWD", period: "year" } },
      { ...full, price: { amount: 25000, currency: "TWD", period: "week" } },
      { ...full, price: { amount: 25000, currency: "TWD" } },
      { ...full, note: "一".repeat(41) },
      { ...full, note: { "zh-Hant": "一".repeat(41) } },
      { ...full, note: 3 },
      { ...full, action: "buy-now" },
      { ...full, action: "link" },
      { ...full, action: "link", url: "http://registry.example.com/buy" },
      { ...full, url: "javascript:alert(1)" },
      { ...full, termsUrl: "http://registry.example.com/terms" },
      { ...full, termsUrl: "not a url" },
    ];
    for (const offer of broken) expect(parseOffer(offer), JSON.stringify(offer)).toBeUndefined();
    for (const bad of [null, "25000", [full], 1]) expect(parseOffer(bad)).toBeUndefined();
  });

  it("counts characters, not bytes: 40 CJK characters is the limit", () => {
    expect(parseOffer({ note: "一".repeat(40) })).toEqual({ note: "一".repeat(40) });
    expect(parseOffer({ note: "一".repeat(41) })).toBeUndefined();
  });

  it("cleans the note before measuring it", () => {
    const offer = parseOffer({ note: "\u001b[31m限時\u001b[0m\n優惠\u202e" });
    expect(offer).toEqual({ note: "限時 優惠" });
    // 控制序列不算字數:消毒後 40 字以內就收。
    expect(parseOffer({ note: `\u001b[1m${"一".repeat(40)}\u001b[0m` })).toEqual({ note: "一".repeat(40) });
  });
});

describe("httpsUrl", () => {
  it("accepts https only", () => {
    expect(httpsUrl("https://example.com/help")).toBe("https://example.com/help");
    for (const bad of ["http://example.com", "javascript:alert(1)", "mailto:a@b.co", "//example.com", 3, undefined]) {
      expect(httpsUrl(bad)).toBeUndefined();
    }
  });
});
