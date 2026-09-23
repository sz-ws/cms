import { describe, expect, it } from "vitest";
import { buildBreadcrumbs } from "@/components/admin/breadcrumbs";
import { buildAdminNavGroups, sectionsByHref } from "@/components/admin/nav-groups";
import type { AdminMenuItem, AdminNavSection } from "@/ext/admin-menu";

// 麵包屑跟著店家看到的側欄走:站台用 filter:adminMenu 把插件的子頁搬到別的分區時,
// 網址上的上一層(插件主頁)還在原本的分區,不該出現在這一頁的麵包屑裡。

const SECTIONS: AdminNavSection[] = [
  { id: "workspace", label: "Workspace" },
  { id: "commerce", label: "Commerce" },
  { id: "partners", label: "Partners" },
];
const SHOP_LABELS = { browse: "Browse", installed: "Installed" };

// 夥伴插件的主頁在「Partners」,它的庫存子頁被站台搬到「Commerce」;活動是一個資料夾。
const MENU: AdminMenuItem[] = [
  { href: "/admin", title: "Dashboard" },
  { href: "/admin/ext/partner", title: "Partners", section: "partners" },
  { href: "/admin/ext/partner/stock", title: "Stock", section: "commerce" },
  {
    href: "/admin/ext/campaigns",
    title: "Campaigns",
    section: "partners",
    children: [
      { href: "/admin/ext/campaigns", title: "Campaign list" },
      { href: "/admin/ext/campaigns/leaders", title: "Leaders" },
    ],
  },
];

function crumbs(pathname: string, menu: AdminMenuItem[] = MENU): string[] {
  const menuTitles: Record<string, string> = {};
  const folderTitles: Record<string, string> = {};
  for (const item of menu) {
    menuTitles[item.href] = item.title;
    if (item.children?.length) folderTitles[item.href] = item.title;
    for (const child of item.children ?? []) menuTitles[child.href] = child.title;
  }
  const hrefSections = sectionsByHref(buildAdminNavGroups(menu, SECTIONS, SHOP_LABELS));
  return buildBreadcrumbs(pathname, { menuTitles, folderTitles, hrefSections }).map((c) => c.label);
}

describe("admin breadcrumbs", () => {
  it("skips a parent page the sidebar shows in another section", () => {
    expect(crumbs("/admin/ext/partner/stock")).toEqual(["Dashboard", "Stock"]);
  });

  it("uses the nearest sidebar page for pages that are not in the sidebar", () => {
    expect(crumbs("/admin/ext/partner/stock/edit")).toEqual(["Dashboard", "Stock", "Edit"]);
  });

  it("keeps the parent when both sit in the same section", () => {
    expect(crumbs("/admin/ext/campaigns/leaders")).toEqual(["Dashboard", "Campaigns", "Leaders"]);
    const unmoved = MENU.map((item) => (item.href === "/admin/ext/partner/stock" ? { ...item, section: "partners" } : item));
    expect(crumbs("/admin/ext/partner/stock", unmoved)).toEqual(["Dashboard", "Partners", "Stock"]);
  });

  it("keeps the earlier rules: no /admin/ext crumb, no untitled plugin root", () => {
    expect(crumbs("/admin/ext/unknown/page")).toEqual(["Dashboard", "Page"]);
    expect(crumbs("/admin")).toEqual(["Dashboard"]);
  });

  it("without section data nothing is skipped", () => {
    const labels = buildBreadcrumbs("/admin/ext/partner/stock", {
      menuTitles: { "/admin": "Dashboard", "/admin/ext/partner": "Partners", "/admin/ext/partner/stock": "Stock" },
    }).map((c) => c.label);
    expect(labels).toEqual(["Dashboard", "Partners", "Stock"]);
  });
});
