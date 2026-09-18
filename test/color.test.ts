import { describe, it, expect } from "vitest";
import { hexToHsv, hsvToHex, normalizeHex, readableOn, relativeLuminance } from "../src/lib/color";

// 後台主色的色彩工具(src/lib/color.ts)。

describe("normalizeHex", () => {
  it("接受三碼、六碼、有無 #、大小寫,一律回小寫六碼", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("5672E4")).toBe("#5672e4");
    expect(normalizeHex("  #5672e4 ")).toBe("#5672e4");
  });

  it("其他字串一律 null(不會被拼進 CSS)", () => {
    for (const bad of ["", "#12", "#1234567", "red", "#zzzzzz", "#fff;} body{display:none"]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe("hexToHsv / hsvToHex", () => {
  it("基本色互轉", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 100, v: 100 });
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 100, v: 100 });
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToHex({ h: 240, s: 100, v: 100 })).toBe("#0000ff");
    expect(hsvToHex({ h: 0, s: 0, v: 100 })).toBe("#ffffff");
  });

  it("來回轉換誤差不超過捨入", () => {
    for (const hex of ["#5672e4", "#e0457b", "#2f9e6e", "#1f1f1f"]) {
      const back = hsvToHex(hexToHsv(hex));
      const diff = [1, 3, 5].map((i) =>
        Math.abs(Number.parseInt(hex.slice(i, i + 2), 16) - Number.parseInt(back.slice(i, i + 2), 16)),
      );
      expect(Math.max(...diff)).toBeLessThanOrEqual(3);
    }
  });
});

describe("readableOn", () => {
  it("深色主色配白字、淺色主色配黑字", () => {
    expect(readableOn("#5672e4")).toBe("#ffffff");
    expect(readableOn("#1f1f1f")).toBe("#ffffff");
    expect(readableOn("#f5d90a")).toBe("#000000");
    expect(readableOn("#ffc0cb")).toBe("#000000");
  });

  it("相對亮度在 0–1", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });
});
