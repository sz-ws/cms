import { describe, it, expect } from "vitest";
import {
  validateFieldSet,
  ContentValidationError,
} from "../src/ext/dx/content-provider";
import { buildFieldValue } from "../src/ext/dx/fields/field-values";
import type { ContentLeafFieldDef } from "../src/ext/capabilities";

// Forms submission 驗證的核心邏輯(純函式,不需 DB)—— server 端 validateFieldSet
// 與 client 端 buildFieldValue。這兩個是 forms 提交「驗證 + 正規化」的單一來源,
// 也與 contents 共用同一份 validator(第 2 點:重用而非重造)。

const fields: ContentLeafFieldDef[] = [
  { key: "name", type: "text", required: true },
  { key: "age", type: "number" },
  { key: "subscribed", type: "boolean" },
];

describe("validateFieldSet (forms submission server-side validation)", () => {
  it("normalises and keeps only declared fields (drops unknown)", () => {
    const out = validateFieldSet(fields, { name: "Suko", age: 30, bogus: "x" }, "");
    expect(out).toEqual({ name: "Suko", age: 30 });
  });

  it("rejects missing required with a per-field error", () => {
    try {
      validateFieldSet(fields, { age: 30 }, "");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ContentValidationError);
      expect((e as ContentValidationError).fields.name).toBeTruthy();
    }
  });

  it("rejects wrong type", () => {
    expect(() =>
      validateFieldSet(fields, { name: "Suko", age: "old" }, ""),
    ).toThrow(ContentValidationError);
  });

  it("omits empty optional fields (sparse doc)", () => {
    expect(validateFieldSet(fields, { name: "Suko" }, "")).toEqual({
      name: "Suko",
    });
  });
});

describe("buildFieldValue (client editor→stored shaping)", () => {
  it("number string → number", () => {
    expect(buildFieldValue({ key: "age", type: "number" }, "30")).toBe(30);
  });

  it("empty number → undefined (skip)", () => {
    expect(buildFieldValue({ key: "age", type: "number" }, "")).toBeUndefined();
  });

  it("boolean → boolean", () => {
    expect(buildFieldValue({ key: "s", type: "boolean" }, true)).toBe(true);
  });

  it("date epoch → epoch", () => {
    const ms = 1_700_000_000_000;
    expect(buildFieldValue({ key: "d", type: "date" }, ms)).toBe(ms);
  });
});
