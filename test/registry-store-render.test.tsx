import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商店卡片與詳情頁的伺服器端渲染。
//   - 免費插件(沒有 offer / access):渲染結果與付費插件功能加入之前逐字相同(snapshot 由
//     改版前的元件產生)
//   - 付費插件:沒開通只多一行價格、按鈕換成「聯絡提供者」;已安裝的沒有更新鈕;已開通的
//     跟免費一樣;別的來源列出的同 id 寫「已從 <主機> 安裝」

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, prefetch: () => {}, push: () => {} }),
  usePathname: () => "/admin/extensions",
}));

import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import {
  cardBlockLabel,
  ExtensionDetail,
  FeaturedCard,
  sourceErrorText,
  StoreCard,
} from "../src/app/(admin)/admin/extensions/RegistryBrowser";
import type { RegistryEntry } from "../src/app/(admin)/admin/extensions/registry-types";

const zh = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, node));

const noop = () => {};
const nameOf = (id: string) => id;
const messages = getMessages("zh-Hant");
const t = (key: keyof typeof messages, params?: Record<string, string | number>) =>
  messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name]));
// StatusButton 把標籤拆成一個字一個 span:比對文字前先拿掉標籤。
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const FREE: RegistryEntry = {
  id: "reviews",
  kind: "declarative",
  name: "評論",
  version: "1.1.0",
  coreApi: "^1.0.0",
  description: "在商品頁收集評論。",
  author: "Acme",
  source: "https://registry.example.com",
  installed: false,
  installedVersion: null,
  conflict: null,
  installedSource: null,
  compatible: true,
  license: "MIT",
  category: "content",
  homepage: "https://example.com/reviews",
  supportUrl: "https://example.com/help",
};

const card = (entry: RegistryEntry, blocked: string | null = null) =>
  zh(createElement(StoreCard, { entry, blocked, nameOf, onClick: noop, onInstalled: noop }));
const featured = (entry: RegistryEntry, blocked: string | null = null) =>
  zh(createElement(FeaturedCard, { entry, blocked, nameOf, onClick: noop, onInstalled: noop }));
const detail = (entry: RegistryEntry) =>
  zh(
    createElement(ExtensionDetail, {
      entry,
      entries: [entry],
      installed: new Map(),
      services: [],
      onBack: noop,
      onOpen: noop,
      onInstalled: noop,
    }),
  );

describe("free entries render exactly as before", () => {
  const cases: [string, RegistryEntry][] = [
    ["declarative", FREE],
    ["declarative with an update", { ...FREE, installed: true, installedVersion: "1.0.0" }],
    ["declarative installed", { ...FREE, installed: true, installedVersion: "1.1.0" }],
    ["code", { ...FREE, id: "loyalty", kind: "code", name: "點數" }],
    ["code with an update", { ...FREE, id: "loyalty", kind: "code", name: "點數", installed: true, installedVersion: "1.0.0" }],
  ];
  for (const [name, entry] of cases) {
    it(name, () => {
      expect(card(entry)).toMatchSnapshot("card");
      expect(featured(entry)).toMatchSnapshot("featured");
      expect(detail(entry)).toMatchSnapshot("detail");
    });
  }
});

const PAID: RegistryEntry = {
  ...FREE,
  access: "locked",
  offer: {
    price: { amount: 25000, currency: "TWD", period: "year" },
    note: { "zh-Hant": "每站,含設定與一年支援", en: "Per site" },
    termsUrl: "https://registry.example.com/terms",
  },
};

const contactLink = /<a href="https:\/\/example\.com\/help" target="_blank" rel="noopener noreferrer"[^>]*>聯絡提供者<\/a>/;

describe("paid entries this key has not been given", () => {
  it("the card adds one price line and swaps the button for Contact provider", () => {
    const html = card(PAID);
    expect(html).toContain("NT$25,000 / 年");
    expect(html).toMatch(contactLink);
    expect(text(html)).not.toContain("取得");
    expect(featured(PAID)).toContain("NT$25,000 / 年");
    expect(featured(PAID)).toMatch(contactLink);
  });

  it("every period has its own label; a note stands in for a missing price", () => {
    expect(card({ ...PAID, offer: { price: { amount: 15000, currency: "TWD", period: "once" } } })).toContain("NT$15,000 一次");
    expect(card({ ...PAID, offer: { price: { amount: 12.5, currency: "USD", period: "month" } } })).toContain("$12.50 / 月");
    expect(card({ ...PAID, offer: { note: "依人數報價" } })).toContain("依人數報價");
  });

  it("requested and expired are not installable either", () => {
    for (const access of ["requested", "expired"] as const) {
      const html = card({ ...PAID, access });
      expect(html).toMatch(contactLink);
      expect(text(html)).not.toContain("取得");
    }
  });

  it("an email is the contact when there is no support URL; with neither, it says not activated", () => {
    const mail = card({ ...PAID, supportUrl: undefined, supportEmail: "sales@example.com" });
    expect(mail).toContain('href="mailto:sales@example.com"');
    const none = card({ ...PAID, supportUrl: undefined });
    expect(none).toContain("尚未開通");
    expect(none).not.toContain("聯絡提供者");
    expect(detail({ ...PAID, supportUrl: undefined })).toContain("要先請 registry.example.com 開通。");
  });

  it("a code plugin shows the price and the contact instead of the developer install", () => {
    const code = { ...PAID, id: "loyalty", kind: "code" as const };
    expect(card(code)).toMatch(contactLink);
    expect(card(code)).not.toContain("開發者安裝");
    const page = detail(code);
    expect(page).toMatch(contactLink);
    expect(page).not.toContain("給開發者");
    expect(page).not.toContain("npx @sz.ws/cms add");
  });

  it("the detail page leads with the price and names the provider and the terms", () => {
    const page = detail(PAID);
    expect(page).toContain("NT$25,000");
    expect(page).toContain("/ 年");
    expect(page).toContain("每站,含設定與一年支援");
    expect(page).toMatch(contactLink);
    expect(page).toMatch(/<dt[^>]*>提供者<\/dt><dd[^>]*>registry\.example\.com<\/dd>/);
    expect(page).toMatch(/<dt[^>]*>條款<\/dt><dd[^>]*><a href="https:\/\/registry\.example\.com\/terms" target="_blank" rel="noopener noreferrer"/);
    // 作者那列改叫「作者」,不跟「提供者」撞名。
    expect(page).toMatch(/<dt[^>]*>作者<\/dt><dd[^>]*>Acme<\/dd>/);
    expect(page.indexOf("NT$25,000")).toBeLessThan(page.indexOf("聯絡提供者"));
  });

  it("installed but not given: Installed, no update button, no price", () => {
    const entry = { ...PAID, installed: true, installedVersion: "1.0.0" };
    for (const html of [card(entry), featured(entry)].map(text)) {
      expect(html).toContain("已安裝");
      expect(html).not.toContain("更新");
      expect(html).not.toContain("NT$25,000");
    }
    const page = detail(entry);
    expect(page).toContain("新版要先請 registry.example.com 開通才能更新，目前安裝的版本可以繼續使用。");
    expect(page).not.toContain("v1.0.0 → v1.1.0");
    expect(page).toContain("v1.0.0");
    const code = { ...entry, id: "loyalty", kind: "code" as const };
    expect(text(card(code))).toContain("已安裝");
    expect(text(card(code))).not.toContain("可更新");
  });
});

describe("paid entries this key has been given", () => {
  it("look like free ones: Get, no price, update when there is one", () => {
    const granted = { ...PAID, access: "granted" as const };
    expect(text(card(granted))).toContain("取得");
    expect(card(granted)).not.toContain("NT$25,000");
    expect(card(granted)).not.toContain("聯絡提供者");
    const update = card({ ...granted, installed: true, installedVersion: "1.0.0" });
    expect(text(update)).toContain("更新");
  });
});

describe("source errors", () => {
  it("a refused key names the source and the provider, never an http code", () => {
    for (const status of [401, 403]) {
      expect(sourceErrorText(t, { source: "https://registry.example.com/", error: `http ${status}`, status })).toBe(
        "registry.example.com 的金鑰已失效，請向提供者確認。",
      );
    }
    for (const e of [
      { source: "https://registry.example.com", error: "http 500", status: 500 },
      { source: "https://registry.example.com", error: "invalid JSON in registry.json" },
    ]) {
      const text = sourceErrorText(t, e);
      expect(text).toBe("無法載入 registry.example.com 的擴充功能清單。");
      expect(text).not.toMatch(/\d{3}|http|JSON/);
    }
  });
});

describe("the same id from another source", () => {
  it("says where the installed one came from, with no update button", () => {
    const entry: RegistryEntry = {
      ...FREE,
      version: "2.0.0",
      conflict: "source",
      installedSource: "https://registry-a.example.com/plugins",
    };
    const blocked = cardBlockLabel(t, entry, new Map());
    expect(blocked).toBe("已從 registry-a.example.com 安裝");
    const html = text(card(entry, blocked));
    expect(html).toContain("已從 registry-a.example.com 安裝");
    expect(html).not.toContain("更新");
    expect(html).not.toContain("取得");
  });

  it("a locked plugin that is installed from this source does not ask for other plugins", () => {
    const entry: RegistryEntry = {
      ...PAID,
      installed: true,
      installedVersion: "1.0.0",
      requiresExtensions: [{ id: "shop" }],
    };
    expect(cardBlockLabel(t, entry, new Map())).toBeNull();
    // 已開通、有新版、缺必要插件 → 照舊擋在「需要其他插件」。
    expect(cardBlockLabel(t, { ...entry, access: "granted" }, new Map())).toBe("需要其他插件");
  });
});
