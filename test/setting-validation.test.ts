import { describe, expect, it } from "vitest";
import {
  coerceSettingInput,
  incompatibleSettingContract,
  validateSettingEntries,
  validateSettingValue,
} from "../src/lib/setting-validation";
import { defineExtension } from "../src/ext/types";

describe("setting value validation", () => {
  it("validates primitive types and finite numbers", () => {
    expect(validateSettingValue({ key: "n", type: "number" }, 3)).toBeNull();
    expect(validateSettingValue({ key: "n", type: "number" }, Infinity)).toBe(
      "expected_number",
    );
    expect(validateSettingValue({ key: "b", type: "boolean" }, "true")).toBe(
      "expected_boolean",
    );
  });

  it("rejects blank required values", () => {
    expect(
      validateSettingValue({ key: "token", type: "text", required: true }, "  "),
    ).toBe("required");
  });

  it("enforces select options", () => {
    const field = {
      key: "mode",
      type: "select" as const,
      options: [{ value: "safe" }, { value: "fast" }],
    };
    expect(validateSettingValue(field, "safe")).toBeNull();
    expect(validateSettingValue(field, "unknown")).toBe("invalid_option");
  });

  it("keeps textarea JSON compatibility", () => {
    expect(validateSettingValue({ key: "sources", type: "textarea" }, ["a"])).toBeNull();
    expect(
      validateSettingValue({ key: "config", type: "textarea" }, { enabled: true }),
    ).toBeNull();
  });

  it("returns structured errors keyed by persisted setting key", () => {
    const fields = new Map([
      ["core.count", { key: "core.count", type: "number" as const }],
      [
        "ext.demo.mode",
        {
          key: "mode",
          type: "select" as const,
          options: [{ value: "on" }],
        },
      ],
    ]);
    expect(
      validateSettingEntries(fields, {
        "core.count": "3",
        "ext.demo.mode": "off",
      }),
    ).toEqual([
      { key: "core.count", code: "expected_number" },
      { key: "ext.demo.mode", code: "invalid_option" },
    ]);
  });

  it("does not coerce an empty number input to zero", () => {
    expect(coerceSettingInput({ type: "number" }, "")).toBeNull();
    expect(coerceSettingInput({ type: "number" }, "0")).toBe(0);
  });

  it("detects persisted setting contract changes", () => {
    const previous = [
      { key: "apiKey", type: "text" as const, secret: false },
      {
        key: "mode",
        type: "select" as const,
        options: [{ value: "a" }, { value: "b" }],
      },
    ];
    expect(
      incompatibleSettingContract(previous, [
        { key: "apiKey", type: "text", secret: true },
        { key: "mode", type: "select", options: [{ value: "a" }] },
      ]),
    ).toEqual(["apiKey", "mode"]);
  });

  it("allows adding settings but rejects removing existing keys", () => {
    expect(
      incompatibleSettingContract(
        [{ key: "old", type: "text" }],
        [{ key: "new", type: "number" }],
      ),
    ).toEqual(["old"]);
    expect(
      incompatibleSettingContract(
        [{ key: "keep", type: "text" }],
        [
          { key: "keep", type: "text" },
          { key: "new", type: "number" },
        ],
      ),
    ).toEqual([]);
  });
});

describe("color settings (1.40.0)", () => {
  const field = { key: "adminAccent", type: "color" as const };

  it("accepts only normalised #rrggbb — the value ends up inside CSS", () => {
    expect(validateSettingValue(field, "#5672e4")).toBeNull();
    expect(validateSettingValue(field, "")).toBeNull();
    for (const bad of ["#5672E4", "5672e4", "#abc", "red", "#5672e4;}body{display:none"]) {
      expect(validateSettingValue(field, bad)).toBe("invalid_color");
    }
    expect(validateSettingValue(field, 5672)).toBe("expected_string");
  });

  it("defineExtension accepts swatches on color settings only", () => {
    const base = { id: "demo", name: "Demo", version: "0.1.0", coreApi: "^1.40.0" };
    const color = { key: "brand", label: "Brand", type: "color" as const, default: "#5672e4" };
    expect(() =>
      defineExtension({ ...base, settings: [{ ...color, swatches: [{ value: "#e0457b", label: "Pink" }] }] }),
    ).not.toThrow();
    expect(() =>
      defineExtension({ ...base, settings: [{ ...color, swatches: [{ value: "#E0457B", label: "Pink" }] }] }),
    ).toThrow();
    expect(() => defineExtension({ ...base, settings: [{ ...color, default: "pink" }] })).toThrow();
  });
});
