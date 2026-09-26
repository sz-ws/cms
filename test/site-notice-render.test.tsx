import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.56.0:網站公告的設定欄位(日期選擇器、字數上限、沒開時收起來)與 core 公開外框的公告列。

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages } from "@/lib/i18n/index";
import { SettingsWorkspace } from "@/components/admin/SettingsWorkspace";
import { CORE_SETTINGS } from "@/lib/settings";
import { SITE_NOTICE_KEYS, SITE_NOTICE_MAX_LENGTH } from "@/lib/site-notice";
import { SiteNoticeBar } from "../src/app/(public)/site-notice";

const noticeFields = CORE_SETTINGS.filter((field) => field.group === "notice");

function renderNoticeSettings(values: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale: "zh-Hant", messages: getMessages("zh-Hant") },
      createElement(SettingsWorkspace, {
        sections: [{ id: "core-notice", title: "網站公告", keyPrefix: "", fields: noticeFields }],
        values,
      }),
    ),
  );
}

describe("notice settings card", () => {
  it("shows only the switch while the notice is off", () => {
    const html = renderNoticeSettings({});
    expect(html).toContain("顯示公告");
    expect(html).not.toContain("公告內容");
    expect(html).not.toContain('type="date"');
  });

  it("shows the text, link and date pickers once switched on", () => {
    const html = renderNoticeSettings({
      [SITE_NOTICE_KEYS.enabled]: true,
      [SITE_NOTICE_KEYS.text]: "中秋節公休",
      [SITE_NOTICE_KEYS.startsOn]: "2026-10-01",
    });
    expect(html).toContain("公告內容");
    expect(html).toMatch(new RegExp(`<input[^>]*maxLength="${SITE_NOTICE_MAX_LENGTH}"[^>]*value="中秋節公休"`));
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-10-01"/);
  });
});

describe("SiteNoticeBar", () => {
  it("renders plain text without a link", () => {
    const html = renderToStaticMarkup(createElement(SiteNoticeBar, { notice: { text: "今日公休" } }));
    expect(html).toContain("今日公休");
    expect(html).not.toContain("<a");
  });

  it("links site paths in place and other sites in a new tab", () => {
    const inSite = renderToStaticMarkup(
      createElement(SiteNoticeBar, { notice: { text: "新品上市", href: "/products" } }),
    );
    expect(inSite).toMatch(/<a[^>]*href="\/products"/);
    expect(inSite).not.toContain("_blank");
    const outside = renderToStaticMarkup(
      createElement(SiteNoticeBar, { notice: { text: "粉絲團", href: "https://example.com/fb" } }),
    );
    expect(outside).toMatch(/<a[^>]*href="https:\/\/example.com\/fb"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("has no motion classes", () => {
    const html = renderToStaticMarkup(createElement(SiteNoticeBar, { notice: { text: "x" } }));
    expect(html).not.toMatch(/animate-|marquee/);
  });
});
