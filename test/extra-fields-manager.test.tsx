import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 設定頁的額外欄位卡(ExtraFieldsManager)與它在設定面板裡的位置。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages } from "@/lib/i18n/index";
import { ExtraFieldsManager } from "@/components/admin/ExtraFieldsManager";
import { SettingsWorkspace } from "@/components/admin/SettingsWorkspace";
import type { ExtraFieldsSetting } from "@/lib/extra-fields";

const inAdmin = (child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, child),
  );

const TYPES = [
  { type: "blog.post", label: "文章" },
  { type: "blog.page", label: "頁面" },
];

const SETTING: ExtraFieldsSetting = {
  "blog.post": [
    { key: "subtitle", label: "副標題", type: "text", public: true },
    { key: "costNote", label: "成本備註", type: "textarea", public: false },
  ],
};

describe("ExtraFieldsManager", () => {
  it("lists the first content type's fields with their name, key, type and visibility", () => {
    const html = inAdmin(createElement(ExtraFieldsManager, { types: TYPES, initialSetting: SETTING }));
    expect(html).toContain("額外欄位");
    expect(html).toContain('value="副標題"');
    expect(html).toContain('value="subtitle"');
    expect(html).toContain('value="成本備註"');
    expect(html).toContain("單行文字");
    expect(html).toContain("多行文字");
    expect(html).toContain("代號是網站程式讀這個欄位用的名字");
    expect(html).toContain("公開的欄位網站前台讀得到");
    expect(html).toContain("新增欄位");
    // 每個按鈕都不會送出外層的設定表單。
    expect(html).not.toMatch(/<button(?![^>]*type="button")[^>]*>/);
  });

  it("shows an empty state for a type without fields, and when there are no types", () => {
    const empty = inAdmin(createElement(ExtraFieldsManager, { types: TYPES, initialSetting: {} }));
    expect(empty).toContain("這種內容還沒有額外欄位。");
    const none = inAdmin(createElement(ExtraFieldsManager, { types: [], initialSetting: {} }));
    expect(none).toContain("目前沒有內容類型");
    expect(none).not.toContain("新增欄位");
  });
});

describe("SettingsWorkspace", () => {
  it("gives additional fields their own card and quick-nav entry on the core tab", () => {
    const html = inAdmin(
      createElement(SettingsWorkspace, {
        sections: [
          {
            id: "core-general",
            title: "一般",
            keyPrefix: "",
            fields: [{ key: "core.siteTitle", label: "網站標題", type: "text", default: "" }],
          },
        ],
        values: {},
        extraFieldsSection: createElement("p", null, "extra-fields-card"),
        coreAddon: createElement("p", null, "core-addon-card"),
      }),
    );
    expect(html).toContain('id="section-extra-fields"');
    expect(html.indexOf("extra-fields-card")).toBeLessThan(html.indexOf("core-addon-card"));
    expect(html).toMatch(/<button[^>]*>額外欄位/);
  });
});
