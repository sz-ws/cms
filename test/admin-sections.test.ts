import { describe, it, expect } from "vitest";
import {
  defaultAdminSections,
  normalizeAdminSections,
  type AdminMenuItem,
  type AdminNavSection,
} from "../src/ext/admin-menu";
import { buildAdminNavGroups } from "../src/components/admin/nav-groups";

// 1.40.0:側欄分區是資料(defaultAdminSections → filter:adminSections →
// normalizeAdminSections),項目依 section 切成群組(nav-groups.ts)。純函式。

const LABELS = {
  workspace: "工作區",
  content: "內容",
  commerce: "商務",
  shop: "市集",
  system: "系統",
};
const SHOP = { browse: "瀏覽", installed: "已安裝" };
const DEFAULTS = defaultAdminSections(LABELS);

const MENU: AdminMenuItem[] = [
  { href: "/admin", title: "儀表板" },
  { href: "/admin/media", title: "媒體庫" },
  { href: "/admin/ext/blog", title: "文章", section: "content" },
  {
    href: "/admin/ext/shop",
    title: "商店",
    section: "commerce",
    children: [
      { href: "/admin/ext/shop", title: "訂單" },
      { href: "/admin/ext/shop/verify", title: "對帳佇列" },
    ],
  },
  { href: "/admin/ext/cron", title: "排程", section: "system" },
  { href: "/admin/extensions", title: "擴充功能" },
  { href: "/admin/account", title: "帳戶" },
  { href: "/admin/settings", title: "設定" },
  { href: "/admin/users", title: "成員" },
];

const shape = (groups: ReturnType<typeof buildAdminNavGroups>) =>
  groups.map((group) => [group.label, group.items.map((item) => item.title)]);

describe("buildAdminNavGroups with the built-in sections", () => {
  it("renders the 1.39.0 layout: workspace, content, commerce, shop, system", () => {
    expect(shape(buildAdminNavGroups(MENU, DEFAULTS, SHOP))).toEqual([
      ["工作區", ["儀表板", "媒體庫"]],
      ["內容", ["文章"]],
      ["商務", ["商店"]],
      ["市集", ["瀏覽", "已安裝"]],
      ["系統", ["成員", "排程", "設定"]],
    ]);
  });

  it("keeps folders nested and marks extension vs core items", () => {
    const groups = buildAdminNavGroups(MENU, DEFAULTS, SHOP);
    const shop = groups.find((group) => group.id === "commerce")!.items[0];
    expect(shop.kind).toBe("extension");
    expect(shop.children?.map((child) => child.title)).toEqual(["訂單", "對帳佇列"]);
    expect(groups[0].items[0].kind).toBe("core");
  });

  it("drops empty sections", () => {
    const groups = buildAdminNavGroups([{ href: "/admin", title: "儀表板" }], DEFAULTS, SHOP);
    expect(shape(groups)).toEqual([["工作區", ["儀表板"]]]);
  });
});

describe("site-defined sections", () => {
  const SITE: AdminNavSection[] = [
    { id: "workspace", label: "數據中心", order: 0 },
    { id: "content", label: "內容", order: 20, collapse: "active" },
    { id: "members", label: "會員", order: 30, collapse: "active" },
    { id: "commerce", label: "電商", order: 40, collapse: "active" },
    { id: "shop", label: "加值服務", order: 70, collapse: "active" },
    { id: "system", label: "系統", order: 80, collapse: "active" },
  ];

  it("lets an explicit section move core items, keeping menu order inside a section", () => {
    const menu = MENU.map((item) =>
      item.href === "/admin/media"
        ? { ...item, section: "content" }
        : item.href === "/admin/users"
          ? { ...item, title: "會員管理", section: "members" }
          : item,
    );
    expect(shape(buildAdminNavGroups(menu, SITE, SHOP))).toEqual([
      ["數據中心", ["儀表板"]],
      ["內容", ["媒體庫", "文章"]],
      ["會員", ["會員管理"]],
      ["電商", ["商店"]],
      ["加值服務", ["瀏覽", "已安裝"]],
      ["系統", ["排程", "設定"]],
    ]);
  });

  it("carries the collapse mode through to the group", () => {
    const groups = buildAdminNavGroups(MENU, SITE, SHOP);
    expect(groups.find((group) => group.id === "workspace")?.collapse).toBeUndefined();
    expect(groups.find((group) => group.id === "commerce")?.collapse).toBe("active");
  });

  it("sends items with an unknown section to content", () => {
    const menu: AdminMenuItem[] = [
      { href: "/admin/ext/promos", title: "優惠碼", section: "marketing" },
    ];
    expect(shape(buildAdminNavGroups(menu, SITE, SHOP))).toEqual([["內容", ["優惠碼"]]]);
  });

  it("falls back to the first section when a site removed content too", () => {
    const menu: AdminMenuItem[] = [{ href: "/admin/ext/blog", title: "文章" }];
    const sections = [{ id: "workspace", label: "數據中心", order: 0 }];
    expect(shape(buildAdminNavGroups(menu, sections, SHOP))).toEqual([["數據中心", ["文章"]]]);
  });
});

describe("normalizeAdminSections", () => {
  it("sorts by order and keeps the original order on ties", () => {
    const sections = normalizeAdminSections(
      [
        { id: "b", label: "B", order: 10 },
        { id: "a", label: "A", order: 0 },
        { id: "c", label: "C", order: 10 },
      ],
      DEFAULTS,
    );
    expect(sections.map((section) => section.id)).toEqual(["a", "b", "c"]);
  });

  it("drops malformed entries and duplicate ids (first wins)", () => {
    const sections = normalizeAdminSections(
      [
        { id: "workspace", label: "數據中心", order: 0 },
        { id: "workspace", label: "重複", order: 1 },
        { id: "Bad Id", label: "x", order: 2 },
        { id: "empty", label: "  ", order: 3 },
        { id: "nan", label: "x", order: Number.NaN },
        null,
        "system",
        { id: "system", label: "系統", order: 80, collapse: "sideways" },
      ],
      DEFAULTS,
    );
    expect(sections).toEqual([
      { id: "workspace", label: "數據中心", order: 0 },
      { id: "system", label: "系統", order: 80 },
    ]);
  });

  it("returns the defaults when a filter returns nothing usable", () => {
    expect(normalizeAdminSections(undefined, DEFAULTS)).toBe(DEFAULTS);
    expect(normalizeAdminSections([], DEFAULTS)).toBe(DEFAULTS);
    expect(normalizeAdminSections([{ id: 1 }], DEFAULTS)).toBe(DEFAULTS);
  });
});
