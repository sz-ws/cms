import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 數字設定的單位(1.52.0 SettingField.unit):存的值照舊是分鐘,設定頁在欄位旁換算。
// 「1440 分」對店家不好讀,旁邊寫「= 24 小時」。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages, type Locale } from "@/lib/i18n/index";
import { SettingsWorkspace } from "@/components/admin/SettingsWorkspace";
import { minutesToParts } from "@/components/admin/SettingUnitHint";
import { defineExtension, type Extension } from "@/ext/types";
import type { SettingField } from "@/lib/settings";

const words = (minutes: number, locale: Locale = "zh-Hant") => {
  const m = getMessages(locale);
  return minutesToParts(minutes)
    .map((p) => m[p.n === 1 ? p.one : p.many].replace("{n}", String(p.n)))
    .join(" ");
};

describe("minutesToParts", () => {
  it("兩天以內講小時,再長才換成天", () => {
    expect(words(1440)).toBe("24 小時");
    expect(words(90)).toBe("1 小時 30 分鐘");
    expect(words(2160)).toBe("36 小時");
    expect(words(4320)).toBe("3 天");
    expect(words(2890)).toBe("2 天 10 分鐘");
    expect(words(1440, "en")).toBe("24 hours");
    expect(words(61, "en")).toBe("1 hour 1 minute");
  });

  it("不到一小時或不是正整數時不換算", () => {
    expect(minutesToParts(30)).toEqual([]);
    expect(minutesToParts(Number.NaN)).toEqual([]);
    expect(minutesToParts(-120)).toEqual([]);
    expect(minutesToParts(90.5)).toEqual([]);
  });
});

const holdMinutes: SettingField = { key: "holdMinutes", label: "付款期限（分鐘）", type: "number", unit: "minutes", default: 1440 };

function renderSettings(values: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale: "zh-Hant", messages: getMessages("zh-Hant") },
      createElement(SettingsWorkspace, {
        sections: [{ id: "ext-shop", title: "商店", keyPrefix: "ext.shop.", fields: [holdMinutes] }],
        values,
        initialTab: "extensions",
      }),
    ),
  );
}

describe("settings page", () => {
  it("分鐘數的欄位旁邊寫成小時,存的值不變", () => {
    const html = renderSettings({});
    expect(html).toContain("= 24 小時");
    expect(html).toMatch(/<input[^>]*type="number"[^>]*value="1440"/);
    expect(renderSettings({ "ext.shop.holdMinutes": 4320 })).toContain("= 3 天");
  });

  it("沒有單位的數字欄位照舊", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "zh-Hant", messages: getMessages("zh-Hant") },
        createElement(SettingsWorkspace, {
          sections: [{ id: "ext-x", title: "X", keyPrefix: "ext.x.", fields: [{ key: "n", label: "N", type: "number", default: 1440 }] }],
          values: {},
          initialTab: "extensions",
        }),
      ),
    );
    expect(html).not.toContain("小時");
  });
});

describe("defineExtension", () => {
  const base = { id: "unit-test", name: "Unit", version: "0.1.0", coreApi: "^1.52.0" } satisfies Partial<Extension>;

  it("數字設定可以帶 unit", () => {
    expect(() => defineExtension({ ...base, settings: [holdMinutes] } as Extension)).not.toThrow();
  });

  it("unit 只給數字設定", () => {
    const text = { key: "note", label: "Note", type: "text", unit: "minutes", default: "" } as unknown as SettingField;
    expect(() => defineExtension({ ...base, settings: [text] } as Extension)).toThrow(/unit is only valid for number settings/);
  });
});
