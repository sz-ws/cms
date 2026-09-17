import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 側欄那一列必須是 next/link 的 <a>:react-aria 的連結沒有 RouterProvider 就是
// 整頁重載,後台每點一次就重跑一次 HTML + JS。這裡把「渲染出來的是 next/link」
// 釘住 —— 哪天有人改回 Intent 的 SidebarItem,這支測試會先喊。
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    title,
    ...rest
  }: {
    children: unknown;
    href: string;
    title?: string;
  }) =>
    createElement(
      "a",
      {
        href,
        title,
        "data-next-link": "true",
        "aria-current": (rest as { "aria-current"?: string })["aria-current"],
      },
      children as never,
    ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {} }),
}));

const sidebar = { state: "expanded", isMobile: false, setIsOpenOnMobile: () => {} };
vi.mock("@/components/ui/intent/sidebar", () => ({
  useSidebar: () => sidebar,
}));

vi.mock("@/lib/i18n/I18nProvider", () => ({
  useT: () => (key: string) => key,
}));

import { AdminNavLink } from "@/components/admin/AdminNavLink";
import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

const renderLink = (props: Partial<Parameters<typeof AdminNavLink>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      AdminNavLink,
      { href: "/admin/media", active: false, tooltip: "Media", ...props },
      "Media",
    ),
  );

describe("AdminNavLink", () => {
  it("renders a next/link anchor, not a react-aria link", () => {
    const html = renderLink();
    expect(html).toContain('data-next-link="true"');
    expect(html).toContain('href="/admin/media"');
  });

  it("marks the current page for assistive tech", () => {
    expect(renderLink({ active: true })).toContain('aria-current="page"');
    expect(renderLink({ active: false })).not.toContain("aria-current");
  });

  it("only carries the title hint when the sidebar is docked to icons", () => {
    expect(renderLink()).not.toContain('title="Media"');
    sidebar.state = "collapsed";
    expect(renderLink()).toContain('title="Media"');
    sidebar.state = "expanded";
  });
});

describe("AdminPageSkeleton", () => {
  it("announces itself as a busy region and paints skeleton bars", () => {
    const html = renderToStaticMarkup(createElement(AdminPageSkeleton));
    expect(html).toContain('role="status"');
    expect(html).toContain("admin.loading"); // 由 useT 解析,這裡是 mock 的 key
    expect(html.match(/admin-skeleton/g)?.length ?? 0).toBeGreaterThan(5);
  });
});
