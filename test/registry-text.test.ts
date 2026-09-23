import { describe, it, expect } from "vitest";
import * as core from "../src/lib/registry-text";
import * as cli from "../cli/src/registry-text";

// registry 寫的文字(offer.note、402 的 message)在顯示與印出之前的消毒。core 與 CLI 各有
// 一份(CLI 不 import core);這裡用同一組輸入比對兩邊,改一邊沒改另一邊就會失敗。

const ESC = "\u001b";

const CASES: [string, string][] = [
  ["請聯絡提供者開通。", "請聯絡提供者開通。"],
  [`${ESC}[31m紅字${ESC}[0m`, "紅字"],
  [`${ESC}[2J${ESC}[H清畫面`, "清畫面"],
  [`${ESC}]0;假標題\u0007標題`, "標題"],
  [`${ESC}]8;;https://evil.example${ESC}\\連結${ESC}]8;;${ESC}\\`, "連結"],
  [`\u009b31m八位元 CSI`, "八位元 CSI"],
  [`${ESC}7存游標${ESC}8`, "存游標"],
  ["換行\n與\ttab\r\n", "換行 與 tab"],
  ["\u0000空\u0007字元\u007f\u0085", "空字元"],
  ["abc\u202edef\u2066ghi\u2069", "abcdefghi"],
  [`未結束的 ${ESC}]0;吃到最後`, "未結束的"],
];

describe("sanitizeRegistryText", () => {
  it("removes ANSI sequences and control characters", () => {
    for (const [input, expected] of CASES) expect(core.sanitizeRegistryText(input), JSON.stringify(input)).toBe(expected);
  });

  it("cuts a long message to 200 characters after cleaning", () => {
    const long = `${ESC}[31m${"長".repeat(250)}${ESC}[0m`;
    const out = core.sanitizeRegistryText(long, core.REGISTRY_MESSAGE_MAX);
    expect(out).toBe("長".repeat(200));
    expect(core.registryTextLength(out)).toBe(200);
    // emoji 是一個字,不會被切成半個 surrogate。
    expect(core.sanitizeRegistryText("😀".repeat(3), 2)).toBe("😀😀");
  });

  it("the CLI copy gives the same result for every input", () => {
    const inputs = [...CASES.map(([input]) => input), `${ESC}[31m${"長".repeat(250)}${ESC}[0m`, "😀".repeat(3)];
    for (const input of inputs) {
      expect(cli.sanitizeRegistryText(input), JSON.stringify(input)).toBe(core.sanitizeRegistryText(input));
      expect(cli.sanitizeRegistryText(input, 200)).toBe(core.sanitizeRegistryText(input, 200));
      expect(cli.registryTextLength(input)).toBe(core.registryTextLength(input));
    }
    expect(cli.REGISTRY_MESSAGE_MAX).toBe(core.REGISTRY_MESSAGE_MAX);
  });
});
