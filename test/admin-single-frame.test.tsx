import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 帳戶頁、設定頁(含風格分頁)與儀表板的主角卡片都是單層卡片:外面不再包一圈
// bg-surface/55 的玻璃框。「細邊線」風格下兩層陰影都變成 1px 線,會畫成兩道邊
// (角色頁的修正見 RolesWorkspace)。

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/lib/i18n/I18nProvider", async () => {
  const { getMessages, format } = await import("../src/lib/i18n/index");
  const zh = getMessages("zh-Hant");
  const t = (key: keyof typeof zh, params?: Record<string, string | number>) => format(zh[key], params);
  return {
    useT: () => t,
    useOptionalT: () => t,
    useLocale: () => "zh-Hant",
    useOptionalLocale: () => "zh-Hant",
  };
});

vi.mock("@/components/admin/AdminLink", () => ({
  AdminLink: ({ href, className, children }: { href: string; className?: string; children: unknown }) =>
    createElement("a", { href, className }, children as never),
}));

vi.mock("@/components/admin/StatNumber", () => ({
  StatNumber: ({ value }: { value: number }) => createElement("span", null, String(value)),
}));

import { SettingsWorkspace } from "@/components/admin/SettingsWorkspace";
import { AdminThemeEditor } from "@/components/admin/AdminThemeEditor";
import { ContentTypeCard } from "@/components/admin/dashboard/ContentTypeCard";
import { resolveAdminAppearance } from "@/lib/admin-theme";
import type { DashboardTypeStats } from "@/components/admin/dashboard/aggregate";

const GLASS_SHELL = "bg-surface/55";

/** 每個 <section ...> 開頭標籤的 class。 */
function sectionClasses(html: string): string[] {
  return [...html.matchAll(/<section[^>]*class="([^"]*)"/g)].map((m) => m[1]);
}

describe("settings cards", () => {
  it("每一組設定是一張卡片,沒有外層玻璃框", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsWorkspace, {
        sections: [
          { id: "core-general", title: "一般", keyPrefix: "", fields: [{ key: "core.siteTitle", label: "網站名稱", type: "text" }] },
          { id: "core-seo", title: "SEO", keyPrefix: "", fields: [{ key: "core.siteUrl", label: "網站網址", type: "text" }] },
        ],
        values: {},
        coreAddon: createElement("p", null, "addon"),
      }),
    );
    expect(html).not.toContain(GLASS_SHELL);
    const cards = sectionClasses(html);
    expect(cards).toHaveLength(3);
    for (const cls of cards) expect(cls).toContain("--admin-shadow-card");
  });

  it("風格分頁的表單本身就是卡片", () => {
    const html = renderToStaticMarkup(
      createElement(AdminThemeEditor, { initial: resolveAdminAppearance(undefined, undefined) }),
    );
    expect(html).not.toContain(GLASS_SHELL);
    const form = html.match(/<form[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(form).toContain("--admin-shadow-card");
  });
});

describe("dashboard hero card", () => {
  it("跟其他儀表板卡片一樣只有一層外框", () => {
    const stats = {
      typeKey: "shop.product",
      typeLabel: "商品",
      extName: "商品目錄",
      newHref: "/admin/ext/shop/product/new",
      collectionHref: "/admin/ext/shop/product",
      total: 3,
      published: 3,
      drafts: 0,
    } as unknown as DashboardTypeStats;
    const html = renderToStaticMarkup(
      createElement(ContentTypeCard, {
        stats,
        emphasis: "hero",
        shareOfTotal: 0.75,
        labels: {
          published: "已發布",
          draft: "草稿",
          drafts: "草稿",
          new: "新增",
          viewAll: "查看全部",
          allPublished: "全部已發布",
          awaitingReview: "待處理",
          ofAllContent: "佔全部內容",
        },
      }),
    );
    expect(html).not.toContain(GLASS_SHELL);
    expect(html).not.toContain("backdrop-blur");
    expect(html.startsWith('<div class="flex flex-col gap-6 rounded-')).toBe(true);
  });
});
