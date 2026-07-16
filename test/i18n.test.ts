import { describe, it, expect } from "vitest";
import { en } from "../src/lib/i18n/en";
import { zhHant } from "../src/lib/i18n/zh-hant";
import { getMessages, format } from "../src/lib/i18n/index";

describe("i18n", () => {
  describe("en dictionary", () => {
    it("should have string keys", () => {
      expect(typeof en["nav.dashboard"]).toBe("string");
    });
  });

  describe("zh-Hant dictionary", () => {
    it("should have zh-Hant translations for all en keys", () => {
      const enKeys = Object.keys(en) as (keyof typeof en)[];
      const zhKeys = Object.keys(zhHant) as (keyof typeof zhHant)[];
      for (const key of enKeys) {
        expect(zhKeys).toContain(key);
      }
    });
  });

  describe("getMessages", () => {
    it("should return en messages for 'en' locale", () => {
      const messages = getMessages("en");
      expect(messages["nav.dashboard"]).toBe("Dashboard");
    });

    it("should merge zh-Hant over en for 'zh-Hant' locale", () => {
      const messages = getMessages("zh-Hant");
      expect(messages["nav.dashboard"]).toBe("儀表板");
    });

    it("should fallback to en when zh-Hant key is missing", () => {
      const enOnlyKeys = Object.keys(en).filter(
        (k) => !(k in zhHant),
      ) as (keyof typeof en)[];
      if (enOnlyKeys.length > 0) {
        const messages = getMessages("zh-Hant");
        expect(messages[enOnlyKeys[0]]).toBe(en[enOnlyKeys[0]]);
      }
    });
  });

  describe("format", () => {
    it("should return string as-is when no params", () => {
      expect(format("Hello")).toBe("Hello");
    });

    it("should interpolate single param", () => {
      expect(format("Hello {name}", { name: "World" })).toBe("Hello World");
    });

    it("should interpolate multiple params", () => {
      expect(
        format("{failed} of {total} files failed", { failed: 2, total: 5 }),
      ).toBe("2 of 5 files failed");
    });

    it("should not explode when param is missing", () => {
      expect(format("Hello {name}", {})).toBe("Hello {name}");
    });

    it("should handle numeric params", () => {
      expect(format("{count} items", { count: 42 })).toBe("42 items");
    });
  });
});
