import { describe, expect, it } from "vitest";
import { defineExtension } from "../src/ext/types";

const base = {
  id: "quality-test",
  name: "Quality test",
  version: "1.0.0",
  coreApi: "^1.18.0",
};

describe("code extension manifest validation", () => {
  it("rejects duplicate routes, settings and migration ids", () => {
    expect(() =>
      defineExtension({
        ...base,
        settings: [
          { key: "mode", label: "Mode", type: "text", default: "" },
          { key: "mode", label: "Again", type: "text", default: "" },
        ],
        migrations: [
          { id: "0001", sql: "SELECT 1" },
          { id: "0001", sql: "SELECT 1" },
        ],
        apiRoutes: [
          { method: "GET", path: "items", handler: async () => new Response() },
          { method: "GET", path: "items", handler: async () => new Response() },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects invalid setting defaults", () => {
    expect(() =>
      defineExtension({
        ...base,
        settings: [
          { key: "enabled", label: "Enabled", type: "boolean", default: "yes" },
        ],
      }),
    ).toThrow(/invalid default/);
  });

  it("accepts required settings with an empty initial default", () => {
    expect(
      defineExtension({
        ...base,
        settings: [
          {
            key: "apiKey",
            label: "API key",
            type: "text",
            required: true,
            default: "",
          },
        ],
      }).id,
    ).toBe("quality-test");
  });

  it("rejects required settings on an older coreApi range", () => {
    expect(() =>
      defineExtension({
        ...base,
        coreApi: "^1.17.0",
        settings: [
          {
            key: "apiKey",
            label: "API key",
            type: "text",
            required: true,
            default: "",
          },
        ],
      }),
    ).toThrow(/1\.18\.0/);
  });

  it("rejects non-empty secret defaults", () => {
    expect(() =>
      defineExtension({
        ...base,
        settings: [
          {
            key: "apiKey",
            label: "API key",
            type: "text",
            secret: true,
            default: "plaintext-secret",
          },
        ],
      }),
    ).toThrow(/secret setting default must be empty/);
  });
});
