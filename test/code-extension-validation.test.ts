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

  // spec-extension-i18n.md §1 #1/#2:頂層 name/description 是 LocalizedString。
  // 這組測試釘住的是「型別與 runtime 驗證不同步」那個 bug —— 物件形式過得了 tsc,
  // 卻在 next build 的 collecting page data 才炸,而且炸在不相干的路由上。
  it("accepts a localized name and description", () => {
    const ext = defineExtension({
      ...base,
      name: { "zh-Hant": "近期購買通知", en: "Recent purchases" },
      description: { "zh-Hant": "顯示最近成交", en: "Shows recent orders" },
    });
    expect(ext.name).toEqual({
      "zh-Hant": "近期購買通知",
      en: "Recent purchases",
    });
  });

  // 純字串是 union 的第一分支,舊 manifest 一字不改仍須全過。
  it("accepts a plain string name (back-compat)", () => {
    expect(defineExtension({ ...base, description: "Plain" }).name).toBe(
      "Quality test",
    );
  });

  // 有鍵才算數:空物件沒有任何 locale 可 resolve。
  it("rejects an empty localized name object", () => {
    expect(() => defineExtension({ ...base, name: {} })).toThrow(/name/);
  });

  // 有鍵但值是空字串 = 安靜地沒有名字,同樣要擋(refine 補的就是這一格)。
  it("rejects a localized name whose only locale is blank", () => {
    expect(() =>
      defineExtension({ ...base, name: { "zh-Hant": "" } }),
    ).toThrow(/name/);
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
