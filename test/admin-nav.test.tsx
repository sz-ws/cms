import { beforeEach, describe, expect, it, vi } from "vitest";
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

// 現在在哪一頁、側欄問到每一頁有幾件事在等(1.77.0;真正去問的那一段在 admin-attention-client.test.ts)。
const nav = vi.hoisted(() => ({
  pathname: "/admin",
  counts: {} as Record<string, number>,
  routeKeys: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {} }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

// 整條側欄用得到的 Intent 元件在這裡只是一層 div:要看的是我們自己畫的列。
const sidebar = { state: "expanded", isMobile: false, setIsOpenOnMobile: () => {} };
vi.mock("@/components/ui/intent/sidebar", () => {
  const box = ({ children }: { children?: unknown }) => createElement("div", null, children as never);
  return {
    useSidebar: () => sidebar,
    Sidebar: box,
    SidebarContent: box,
    SidebarFooter: box,
    SidebarHeader: box,
    SidebarLabel: box,
    SidebarSectionGroup: box,
  };
});

vi.mock("@/components/ui/intent/menu", () => {
  const box = ({ children }: { children?: unknown }) => createElement("div", null, children as never);
  return {
    Menu: box,
    MenuContent: box,
    MenuHeader: box,
    MenuItem: box,
    MenuLabel: box,
    MenuSection: box,
    MenuSeparator: () => null,
    MenuTrigger: box,
  };
});

vi.mock("@/lib/i18n/I18nProvider", () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(",")})` : key,
}));

vi.mock("@/components/admin/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/admin/attention")>()),
  useAdminAttention: (routeKey: string) => {
    nav.routeKeys.push(routeKey);
    return nav.counts;
  },
}));

import { AdminNavGroup } from "@/components/admin/AdminNavGroup";
import { AdminNavLink } from "@/components/admin/AdminNavLink";
import { AdminPageLoading } from "@/components/admin/AdminPageLoading";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import type { AdminNavGroupData } from "@/components/admin/nav-groups";

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

describe("AdminPageLoading", () => {
  it("announces itself as a busy region with the accent spinner, centred", () => {
    const html = renderToStaticMarkup(createElement(AdminPageLoading));
    expect(html).toContain('role="status"');
    expect(html).toContain("admin.loading"); // 由 useT 解析,這裡是 mock 的 key
    expect(html).toContain("items-center justify-center");
    expect(html).toContain("var(--admin-accent)");
  });
});

// 1.77.0:有事在等的那一頁旁邊畫一個點。件數是插件報的(插槽 AdminAttention),這裡只看側欄怎麼畫:
// 點在哪一列、收起來的資料夾與分區怎麼交代、收成圖示時放哪裡。點是靜態的,沒有數字。
describe("attention dots in the sidebar", () => {
  const USER = { id: "u1", email: "owner@shop.test", name: "阿明", role: "admin" as const, avatarKey: null };
  const ORDERS = "/admin/ext/orders";
  const REPAIRS = "/admin/ext/repairs";
  const QUOTES = "/admin/ext/repairs/quotes";
  // 「商務」平常收合(只有目前頁面在裡面才展開),裡面有一頁與一個資料夾。
  const GROUPS: AdminNavGroupData[] = [
    {
      id: "workspace",
      label: "工作區",
      items: [
        { href: "/admin", title: "儀表板", kind: "core" },
        { href: "/admin/media", title: "媒體庫", kind: "core" },
      ],
    },
    {
      id: "commerce",
      label: "商務",
      collapse: "active",
      items: [
        { href: ORDERS, title: "訂單管理", kind: "extension" },
        {
          href: REPAIRS,
          title: "報修",
          kind: "extension",
          children: [
            { href: REPAIRS, title: "報修單", kind: "extension" },
            { href: QUOTES, title: "報價", kind: "extension" },
          ],
        },
      ],
    },
  ];

  const DOT = 'data-slot="admin-attention"';
  const waiting = (count: number) => `sidebar.attention(count=${count})`;
  const render = () =>
    renderToStaticMarkup(
      createElement(AdminSidebar, { user: USER, siteTitle: "小店", brandLogo: "", groups: GROUPS }),
    );
  /** 側欄上連到 href 的那一列(資料夾裡的子頁也是)。 */
  const row = (html: string, href: string) =>
    html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>.*?</a>`))?.[0] ?? "";
  /** 標題是 label 的那顆按鈕(分區標題、資料夾)。 */
  const button = (html: string, label: string) =>
    html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))?.[0] ?? "";
  const dots = (html: string) => html.match(/<span[^>]*data-slot="admin-attention"[^>]*>/g) ?? [];

  beforeEach(() => {
    nav.pathname = "/admin";
    nav.counts = {};
    nav.routeKeys = [];
    sidebar.state = "expanded";
  });

  it("asks for the current page's counts (the pathname is the route key)", () => {
    nav.pathname = ORDERS;
    render();
    expect(nav.routeKeys).toEqual([ORDERS]);
  });

  it("draws nothing when nothing is waiting", () => {
    expect(render()).not.toContain(DOT);
    nav.counts = { [ORDERS]: 0 };
    expect(render()).not.toContain(DOT);
  });

  it("marks the row of a page that has something waiting, after its label", () => {
    nav.pathname = "/admin/media";
    nav.counts = { "/admin": 3 };
    const html = render();
    const dashboard = row(html, "/admin");
    expect(dashboard).toContain(DOT);
    expect(dashboard.indexOf(DOT)).toBeGreaterThan(dashboard.indexOf("儀表板"));
    expect(dashboard).toContain(waiting(3));
    expect(row(html, "/admin/media")).not.toContain(DOT);
  });

  it("the dot is static, hidden from assistive tech, and carries no number", () => {
    nav.pathname = ORDERS;
    nav.counts = { "/admin": 3, [ORDERS]: 12, [QUOTES]: 2 };
    const html = render();
    const found = dots(html);
    // 儀表板、訂單管理、收著的「報修」資料夾、資料夾裡(收著看不到)的報價。
    expect(found).toHaveLength(4);
    for (const dot of found) {
      expect(dot).toContain('aria-hidden="true"');
      expect(dot).toContain("rounded-full");
      expect(dot).not.toMatch(/animate|ping|pulse|transition|blur|shadow/);
    }
    // 點是空的:裡面沒有數字,也沒有任何字。
    expect(html).not.toMatch(/data-slot="admin-attention"[^>]*>[^<]/);
  });

  it("a closed folder speaks for its pages; an open one leaves it to the rows", () => {
    // 目前在訂單管理:「商務」展開,「報修」資料夾收著。
    nav.pathname = ORDERS;
    nav.counts = { [REPAIRS]: 1, [QUOTES]: 2 };
    const closed = button(render(), "報修");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain(DOT);
    expect(closed).toContain(waiting(3));

    // 走進資料夾裡的一頁:資料夾展開,點回到各自的列上。
    nav.pathname = QUOTES;
    const html = render();
    const open = button(html, "報修");
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain(DOT);
    expect(row(html, QUOTES)).toContain(DOT);
    expect(row(html, QUOTES)).toContain(waiting(2));
  });

  it("a folder with nothing waiting inside stays unmarked", () => {
    nav.pathname = ORDERS;
    nav.counts = { [ORDERS]: 4 };
    expect(button(render(), "報修")).not.toContain(DOT);
  });

  it("a collapsed section's heading speaks for everything inside it", () => {
    nav.counts = { [ORDERS]: 3, [QUOTES]: 2 };
    const html = render();
    const commerce = button(html, "商務");
    expect(commerce).toContain('aria-expanded="false"');
    expect(commerce).toContain(DOT);
    expect(commerce).toContain(waiting(5));
    expect(button(html, "工作區")).not.toContain(DOT);
  });

  it("an open section's heading stays unmarked: its rows carry the dots", () => {
    nav.pathname = ORDERS;
    nav.counts = { [ORDERS]: 3 };
    const html = render();
    expect(button(html, "商務")).toContain('aria-expanded="true"');
    expect(button(html, "商務")).not.toContain(DOT);
    expect(row(html, ORDERS)).toContain(DOT);
  });

  it("docked to icons: the dot sits on the icon's corner and the tooltip says how many", () => {
    sidebar.state = "collapsed";
    nav.counts = { [ORDERS]: 3, [QUOTES]: 2 };
    const html = render();

    const orders = row(html, ORDERS);
    expect(orders).toContain(`title="訂單管理 · ${waiting(3)}"`);
    expect(dots(orders)).toHaveLength(1);
    expect(dots(orders)[0]).toContain("absolute");
    // 名稱已經在 title 裡:不再放一份報讀文字,免得蓋掉頁面的名字。
    expect(orders).not.toContain("sr-only");

    // 資料夾收成一個連到第一頁的圖示:裡面有事就標。
    const folder = row(html, REPAIRS);
    expect(folder).toContain(`title="報修 · ${waiting(2)}"`);
    expect(dots(folder)).toHaveLength(1);

    expect(row(html, "/admin")).toContain('title="儀表板"');
    expect(row(html, "/admin")).not.toContain(DOT);
    // 圖示列沒有分區標題可以收,每一區都攤開:標題不標。
    expect(button(html, "商務")).not.toContain(DOT);
  });
});

describe("AdminNavGroup", () => {
  const group = (props: { open: boolean; attention?: number }) =>
    renderToStaticMarkup(
      createElement(AdminNavGroup, { label: "商務", onToggle: () => {}, prominent: true, ...props }, "rows"),
    );

  it("shows the dot only while collapsed with something waiting inside", () => {
    expect(group({ open: false, attention: 2 })).toContain('data-slot="admin-attention"');
    expect(group({ open: false, attention: 2 })).toContain("sidebar.attention(count=2)");
    expect(group({ open: true, attention: 2 })).not.toContain('data-slot="admin-attention"');
    expect(group({ open: false, attention: 0 })).not.toContain('data-slot="admin-attention"');
    expect(group({ open: false })).not.toContain('data-slot="admin-attention"');
  });

  it("renders exactly as before when nothing is waiting", () => {
    expect(group({ open: false, attention: 0 })).toBe(group({ open: false }));
  });
});
