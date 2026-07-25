import { describe, it, expect } from "vitest";
import {
  applyEdits,
  getMember,
  getStringMember,
  JsoncParseError,
  parseJsonc,
  quoteJsonString,
} from "./jsonc.js";

describe("parseJsonc", () => {
  it("解析基本型別並記錄位移", () => {
    const text = `{ "a": 1, "b": "x", "c": true, "d": null, "e": [1, 2] }`;
    const root = parseJsonc(text);
    expect(root.kind).toBe("object");
    expect(getStringMember(root, "b")).toBe("x");
    const a = getMember(root, "a");
    expect(a?.value.kind).toBe("number");
    // span 必須精準指向值的字面量,不含前後空白。
    expect(text.slice(a!.value.span.start, a!.value.span.end)).toBe("1");
    const e = getMember(root, "e");
    expect(text.slice(e!.value.span.start, e!.value.span.end)).toBe("[1, 2]");
  });

  it("跳過行註解與區塊註解", () => {
    const text = `{
      // 這是行註解,裡面有 "假的字串" 和 { 括號
      /* 區塊註解
         也有 "引號" */
      "id": "real"
    }`;
    expect(getStringMember(parseJsonc(text), "id")).toBe("real");
  });

  it("註解裡的內容不會被誤認成鍵", () => {
    const text = `{ // "ghost": "no"\n "real": "yes" }`;
    const root = parseJsonc(text);
    expect(getMember(root, "ghost")).toBeUndefined();
    expect(getStringMember(root, "real")).toBe("yes");
  });

  it("容忍尾逗號(JSONC 常見寫法)", () => {
    expect(getStringMember(parseJsonc(`{ "a": "1", }`), "a")).toBe("1");
    const arr = parseJsonc(`[1, 2, ]`);
    expect(arr.kind === "array" && arr.items.length).toBe(2);
  });

  it("處理跳脫字元", () => {
    const root = parseJsonc(`{ "a": "line\\nbreak \\"quoted\\" \\u0041" }`);
    expect(getStringMember(root, "a")).toBe(`line\nbreak "quoted" A`);
  });

  it("格式錯誤丟 JsoncParseError 並帶位移", () => {
    expect(() => parseJsonc(`{ "a": }`)).toThrow(JsoncParseError);
    expect(() => parseJsonc(`{ "a": 1 `)).toThrow(JsoncParseError);
    expect(() => parseJsonc(`{ "a": 1 } trailing`)).toThrow(/多餘內容/);
    expect(() => parseJsonc(`{ /* 沒關 `)).toThrow(/區塊註解沒有結尾/);
  });
});

describe("applyEdits", () => {
  it("只替換指定區間,其餘 byte 完全不動", () => {
    const text = `{\n  // 註解要活著\n  "id": "old",\n  "keep": "me"\n}\n`;
    const root = parseJsonc(text);
    const span = getMember(root, "id")!.value.span;
    const out = applyEdits(text, [
      { span, replacement: quoteJsonString("new") },
    ]);
    expect(out).toBe(`{\n  // 註解要活著\n  "id": "new",\n  "keep": "me"\n}\n`);
  });

  it("多筆編輯由後往前套用,位移不會互相弄歪", () => {
    const text = `{ "a": "1", "b": "2" }`;
    const root = parseJsonc(text);
    const out = applyEdits(text, [
      { span: getMember(root, "a")!.value.span, replacement: `"AAAAAA"` },
      { span: getMember(root, "b")!.value.span, replacement: `"B"` },
    ]);
    expect(out).toBe(`{ "a": "AAAAAA", "b": "B" }`);
  });

  it("零筆編輯 = 原文", () => {
    const text = `{ "a": 1 }`;
    expect(applyEdits(text, [])).toBe(text);
  });

  it("區間重疊直接拒絕,不產生壞檔案", () => {
    expect(() =>
      applyEdits(`0123456789`, [
        { span: { start: 0, end: 5 }, replacement: "x" },
        { span: { start: 3, end: 8 }, replacement: "y" },
      ]),
    ).toThrow(/重疊/);
  });

  it("空區間 = 插入", () => {
    const out = applyEdits(`{ "a": 1 }`, [
      { span: { start: 8, end: 8 }, replacement: `, "b": 2` },
    ]);
    expect(out).toBe(`{ "a": 1, "b": 2 }`);
    expect(getMember(parseJsonc(out), "b")?.value.kind).toBe("number");
  });
});
