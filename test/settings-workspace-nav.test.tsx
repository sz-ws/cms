import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 設定頁:左邊一欄清單、右邊只有選到的那一區(取代原本的四個分頁與錨點列)。
// 這裡只看伺服器畫出來的樣子;清單、網址、搜尋的規則在 settings-nav / settings-search 的測試。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { getMessages, type Locale } from "@/lib/i18n/index";
import { SettingsWorkspace, type SettingsSection } from "@/components/admin/SettingsWorkspace";

const SECTIONS: SettingsSection[] = [
  {
    id: "core-general",
    title: "一般",
    keyPrefix: "",
    fields: [{ key: "core.siteTitle", label: "網站名稱", type: "text", default: "My Site" }],
  },
  {
    id: "core-ai",
    title: "AI",
    keyPrefix: "",
    fields: [{ key: "core.ai.model", label: "模型名稱", type: "text", default: "" }],
  },
  {
    id: "transfer",
    title: "轉帳付款",
    keyPrefix: "ext.transfer.",
    fields: [{ key: "bankName", label: "銀行名稱", type: "text", required: true, default: "" }],
  },
  {
    id: "store",
    title: "商店",
    keyPrefix: "ext.store.",
    fields: [{ key: "holdMinutes", label: "付款期限", type: "number", default: 1440 }],
  },
];

interface RenderOptions {
  tab?: string;
  section?: string;
  locale?: Locale;
  values?: Record<string, unknown>;
  accountKeywords?: string[];
}

function render({ tab, section, locale = "zh-Hant", values = {}, accountKeywords }: RenderOptions = {}) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, messages: getMessages(locale) },
      createElement(SettingsWorkspace, {
        sections: SECTIONS,
        values,
        initialTab: tab,
        initialSection: section,
        accountKeywords,
        styleTab: createElement("p", null, "style-editor"),
        aiConnectSection: createElement("p", null, "ai-connect-card"),
        extraFieldsSection: createElement("p", null, "extra-fields-card"),
        coreAddon: createElement("p", null, "core-addon-card"),
      }),
    ),
  );
}

/** 左邊清單的 <nav>…</nav>。 */
function navOf(html: string): string {
  return html.match(/<nav[^>]*aria-label="設定類別"[\s\S]*?<\/nav>/)?.[0] ?? "";
}

/** 清單裡每個連結的 [網址, 是不是目前這一區]。 */
function navLinks(html: string): [string, boolean][] {
  return [...navOf(html).matchAll(/<a\b([^>]*)>/g)].map((m) => [
    (m[1].match(/href="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&"),
    /aria-current="page"/.test(m[1]),
  ]);
}

describe("設定頁的左邊清單", () => {
  it("是一個有名字的 nav,列出每一區,照原本四個分頁分組", () => {
    const html = render();
    const nav = navOf(html);
    expect(nav).not.toBe("");
    expect(navLinks(html).map(([href]) => href)).toEqual([
      "/admin/settings",
      "/admin/settings?section=core-ai",
      "/admin/settings?section=ai-connect",
      "/admin/settings?section=extra-fields",
      "/admin/settings?section=core-addon",
      "/admin/settings?tab=style",
      "/admin/settings?tab=declarative",
      "/admin/settings?tab=extensions",
      "/admin/settings?tab=extensions&section=store",
      "/admin/account#connected-accounts",
    ]);
    for (const label of ["核心", "一般", "AI 連線", "額外欄位", "來源與權杖", "風格", "宣告式", "擴充功能", "轉帳付款", "商店"]) {
      expect(nav).toContain(label);
    }
  });

  it("沒有原本的分頁列與錨點列", () => {
    const html = render();
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("sticky top-0");
  });

  it("搜尋框有標籤", () => {
    const nav = navOf(render());
    const id = nav.match(/<input[^>]*type="search"[^>]*id="([^"]+)"/)?.[1] ?? nav.match(/<input[^>]*id="([^"]+)"[^>]*type="search"/)?.[1];
    expect(id).toBeTruthy();
    expect(nav).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>[^<]*搜尋設定`));
  });

  it("最後有一個連到帳戶頁的連結,寫的是登入方式與已連結帳號", () => {
    const nav = navOf(render());
    expect(nav).toMatch(/<a[^>]*href="\/admin\/account#connected-accounts"/);
    expect(nav).toContain("我的帳戶");
    expect(nav).toContain("登入方式與已連結帳號");
    const en = render({ locale: "en" });
    expect(en).toContain("My account");
    expect(en).toContain("Sign-in methods and connected accounts");
  });
});

describe("右邊只有選到的那一區", () => {
  it("預設是核心的第一區", () => {
    const html = render();
    expect(navLinks(html).filter(([, current]) => current)).toEqual([["/admin/settings", true]]);
    expect(html).toContain("網站名稱");
    expect(html).not.toContain("模型名稱");
    expect(html).not.toContain("銀行名稱");
    expect(html).not.toContain("付款期限");
  });

  it("?tab=extensions 開擴充功能的第一區", () => {
    const html = render({ tab: "extensions" });
    expect(navLinks(html).filter(([, current]) => current)).toEqual([["/admin/settings?tab=extensions", true]]);
    expect(html).toContain("銀行名稱");
    expect(html).not.toContain("網站名稱");
    expect(html).not.toContain("付款期限");
  });

  it("section 指定哪一區就開哪一區", () => {
    const store = render({ tab: "extensions", section: "store" });
    expect(navLinks(store).filter(([, current]) => current)).toEqual([
      ["/admin/settings?tab=extensions&section=store", true],
    ]);
    expect(store).toContain("付款期限");
    expect(store).not.toContain("銀行名稱");

    const ai = render({ section: "core-ai" });
    expect(ai).toContain("模型名稱");
    expect(ai).toContain('id="section-core-ai"');
    expect(ai).not.toContain("網站名稱");
  });

  it("?tab=style 開風格;其他區的表單收起來", () => {
    const html = render({ tab: "style" });
    expect(navLinks(html).filter(([, current]) => current)).toEqual([["/admin/settings?tab=style", true]]);
    expect(html).toMatch(/<div[^>]*id="section-style"(?![^>]*hidden)[^>]*>/);
    expect(html).toMatch(/<form[^>]*hidden=""/);
  });

  it("有自己儲存鈕的區塊切走時留在頁面上(收起來),草稿不會不見", () => {
    const html = render();
    for (const id of ["section-ai-connect", "section-extra-fields", "section-core-addon"]) {
      expect(html).toMatch(new RegExp(`<section[^>]*id="${id}"[^>]*hidden=""`));
    }
    expect(html).toMatch(/<div[^>]*id="section-style"[^>]*hidden=""/);
    const shown = render({ section: "extra-fields" });
    expect(shown).toMatch(/<section[^>]*id="section-extra-fields"(?![^>]*hidden)[^>]*>/);
    expect(shown).not.toContain("網站名稱");
  });

  it("整頁還是一個表單、一個儲存鈕,瀏覽器不會因為看不到的欄位擋下送出", () => {
    const html = render();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*novalidate=""/i);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain("儲存所有變更");
  });
});

describe("清單上的標記", () => {
  it("必填欄位還沒填的那一區有提醒,其他區沒有", () => {
    const nav = navOf(render());
    const row = (label: string) => nav.match(new RegExp(`<a\\b[^>]*>(?:(?!</a>)[\\s\\S])*${label}(?:(?!</a>)[\\s\\S])*</a>`))?.[0] ?? "";
    expect(row("轉帳付款")).toContain("有必填欄位還沒填");
    expect(row("商店")).not.toContain("有必填欄位還沒填");
    expect(row("一般")).not.toContain("有必填欄位還沒填");
  });

  it("填好之後就沒有提醒", () => {
    const nav = navOf(render({ values: { "ext.transfer.bankName": "第一銀行" } }));
    expect(nav).not.toContain("有必填欄位還沒填");
  });

  it("還沒改任何東西時沒有「未儲存」", () => {
    expect(navOf(render())).not.toContain("有未儲存的變更");
  });
});
