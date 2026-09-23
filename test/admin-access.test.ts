import { describe, it, expect } from "vitest";
import {
  adminPageLevel,
  apiRouteLevel,
  areaKey,
  customRoleCanOpen,
  declarativeRouteAccess,
  deriveAccessSections,
  editorCanOpen,
  extensionLevel,
  filterAdminMenu,
  firstOpenablePath,
  levelOf,
  openablePageCount,
  presetAccess,
  sanitizeAccess,
  type AccessMap,
} from "../src/ext/admin-access";
import {
  defaultAdminSections,
  type AdminMenuItem,
} from "../src/ext/admin-menu";
import { buildAdminNavGroups } from "../src/components/admin/nav-groups";
import {
  sectionLevel,
  setAreaLevel,
  setSectionLevel,
} from "../src/app/(admin)/admin/roles/roles-draft";

// 1.50.0:角色與權限的規則(ext/admin-access.ts)。純函式:矩陣的列從側欄推導、
// 一頁 / 一條 API 的權限怎麼算、側欄怎麼依角色過濾。

const SECTIONS = defaultAdminSections({
  workspace: "工作區",
  content: "內容",
  commerce: "商務",
  shop: "市集",
  system: "系統",
});
const SHOP = { browse: "瀏覽", installed: "已安裝" };

// 管理者看到的完整選單(layout 的形狀:core 項 + extension 項 + 系統項)。
const MENU: AdminMenuItem[] = [
  { href: "/admin", title: "儀表板" },
  { href: "/admin/agent", title: "助理" },
  { href: "/admin/media", title: "媒體庫" },
  { href: "/admin/ext/blog", title: "文章", section: "content" },
  {
    href: "/admin/ext/shop/shipping",
    title: "商店",
    section: "commerce",
    children: [
      { href: "/admin/ext/shop/shipping", title: "運費" },
      { href: "/admin/ext/shop/promos", title: "優惠碼" },
    ],
  },
  { href: "/admin/ext/order-desk", title: "訂單管理", section: "commerce" },
  // 站台用 query 做的篩選捷徑:同一頁,矩陣只留一列。
  { href: "/admin/ext/order-desk?status=paid", title: "待出貨", section: "commerce" },
  { href: "https://example.com/help", title: "說明", section: "system" },
  { href: "/admin/extensions", title: "擴充功能" },
  { href: "/admin/account", title: "帳戶" },
  { href: "/admin/settings", title: "設定" },
  { href: "/admin/users", title: "成員" },
  { href: "/admin/roles", title: "角色與權限" },
];

const GROUPS = buildAdminNavGroups(MENU, SECTIONS, SHOP);

describe("deriveAccessSections", () => {
  const sections = deriveAccessSections(GROUPS);

  it("groups rows by sidebar section, in sidebar order", () => {
    expect(sections.map((s) => s.id)).toEqual(["workspace", "content", "commerce", "shop", "system"]);
    expect(sections[0].areas.map((a) => a.key)).toEqual(["/admin", "/admin/agent", "/admin/media"]);
  });

  it("expands folders into one row per page, keeping the folder name", () => {
    const commerce = sections.find((s) => s.id === "commerce")!;
    expect(commerce.areas.map((a) => [a.key, a.folder ?? null])).toEqual([
      ["/admin/ext/shop/shipping", "商店"],
      ["/admin/ext/shop/promos", "商店"],
      ["/admin/ext/order-desk", null],
    ]);
  });

  it("locks admin-only pages and never offers the dashboard more than view", () => {
    const all = sections.flatMap((s) => s.areas);
    const locked = all.filter((a) => a.locked).map((a) => a.key);
    expect(locked).toEqual(
      expect.arrayContaining(["/admin/agent", "/admin/settings", "/admin/users", "/admin/roles", "/admin/extensions"]),
    );
    expect(all.find((a) => a.key === "/admin")?.max).toBe("view");
    expect(all.find((a) => a.key === "/admin/media")?.max).toBe("edit");
  });

  it("leaves out links that are not admin pages and the personal account page", () => {
    const keys = sections.flatMap((s) => s.areas.map((a) => a.key));
    expect(keys).not.toContain("https://example.com/help");
    expect(keys).not.toContain("/admin/account");
  });

  it("shows a newly enabled extension's pages without any other change", () => {
    const withNew = buildAdminNavGroups(
      [...MENU, { href: "/admin/ext/wallet", title: "錢包", section: "commerce" }],
      SECTIONS,
      SHOP,
    );
    const keys = deriveAccessSections(withNew).flatMap((s) => s.areas.map((a) => a.key));
    expect(keys).toContain("/admin/ext/wallet");
  });
});

describe("levels", () => {
  const access: AccessMap = {
    "/admin/ext/shop/promos": "edit",
    "/admin/ext/shop/shipping": "view",
    "/admin/ext/blog/posts": "view",
  };

  it("an extension page follows itself, or the page it declares accessAs", () => {
    expect(adminPageLevel(access, "shop", { slug: "promos" })).toBe("edit");
    expect(adminPageLevel(access, "shop", { slug: "" })).toBe("none");
    expect(adminPageLevel(access, "blog", { slug: "posts/edit", accessAs: "blog/posts" })).toBe("view");
    // 不在授權裡的隱藏頁,沒有宣告就打不開。
    expect(adminPageLevel(access, "blog", { slug: "posts/edit" })).toBe("none");
    // accessAs 格式不對:不退回別頁。
    expect(adminPageLevel(access, "blog", { slug: "x", accessAs: "Blog/Posts" })).toBe("none");
  });

  it("an API route follows its accessAs page, otherwise the extension's highest level", () => {
    expect(apiRouteLevel(access, "shop", { accessAs: "shop/shipping" })).toBe("view");
    expect(apiRouteLevel(access, "shop", {})).toBe("edit");
    expect(apiRouteLevel(access, "wallet", {})).toBe("none");
    // order-desk 不是 shop 的子頁(前綴相同不算)。
    expect(extensionLevel({ "/admin/ext/order-desk": "edit" }, "shop")).toBe("none");
  });

  it("admin-only paths are never granted, whatever is stored", () => {
    const stored = { "/admin/settings": "edit", "/admin/users": "view" } as AccessMap;
    expect(levelOf(stored, "/admin/settings")).toBe("none");
    expect(levelOf(stored, "/admin/users")).toBe("none");
  });

  it("sanitizes stored access: grantable paths only, dashboard capped at view", () => {
    expect(
      sanitizeAccess({
        "/admin": "edit",
        "/admin/media/": "view",
        "/admin/settings": "edit",
        "/admin/ext/shop?x=1": "edit",
        "/admin/ext/Bad": "edit",
        "/admin/ext/shop/promos": "owner",
      }),
    ).toEqual({ "/admin": "view", "/admin/media": "view", "/admin/ext/shop": "edit" });
    expect(sanitizeAccess(["/admin"])).toEqual({});
    expect(sanitizeAccess(null)).toEqual({});
  });

  it("areaKey drops query, hash and trailing slash", () => {
    expect(areaKey("/admin/ext/shop/?tab=a#x")).toBe("/admin/ext/shop");
    expect(areaKey("/admin")).toBe("/admin");
  });

  it("counts the pages a role can open", () => {
    expect(openablePageCount(access)).toBe(3);
    expect(openablePageCount({})).toBe(0);
  });
});

describe("declarativeRouteAccess", () => {
  const accessFor = declarativeRouteAccess("recipes", [
    { slug: "", contentType: "recipe" },
    { slug: "tags", contentType: "tag" },
    { slug: "tags-again", contentType: "tag" },
  ]);

  it("binds a content type's CRUD to the first page that shows it", () => {
    expect(accessFor("recipe", "recipe")).toBe("recipes");
    expect(accessFor("recipe", "recipe/:id")).toBe("recipes");
    expect(accessFor("tag", "tag/:id/revisions")).toBe("recipes/tags");
  });

  it("leaves the relation picker's options route and page-less types extension-wide", () => {
    expect(accessFor("tag", "tag/options")).toBeUndefined();
    expect(accessFor("note", "note")).toBeUndefined();
  });
});

describe("sidebar filtering", () => {
  it("a custom role sees only pages it can view; folders keep their open children", () => {
    const access: AccessMap = { "/admin/ext/shop/promos": "edit", "/admin/media": "view" };
    const menu = filterAdminMenu(MENU, customRoleCanOpen(access));
    expect(menu.map((m) => m.href)).toEqual([
      "/admin/media",
      "/admin/ext/shop/promos",
      "https://example.com/help",
      "/admin/account",
    ]);
    const folder = menu.find((m) => m.title === "商店")!;
    expect(folder.children?.map((c) => c.href)).toEqual(["/admin/ext/shop/promos"]);
  });

  it("an editor sees the dashboard (the only page requireAuth let them open) and their account", () => {
    const menu = filterAdminMenu(MENU, editorCanOpen);
    expect(menu.map((m) => m.href)).toEqual(["/admin", "https://example.com/help", "/admin/account"]);
  });

  it("the first page a role can open, in sidebar order", () => {
    expect(firstOpenablePath(GROUPS, customRoleCanOpen({ "/admin/ext/order-desk": "view" }))).toBe(
      "/admin/ext/order-desk",
    );
    expect(firstOpenablePath(GROUPS, customRoleCanOpen({}))).toBeNull();
  });
});

describe("presets", () => {
  const sections = deriveAccessSections(GROUPS);

  it("admin gets every grantable page at its maximum, editor the dashboard, guest nothing", () => {
    const admin = presetAccess("admin", sections);
    expect(admin["/admin"]).toBe("view");
    expect(admin["/admin/ext/shop/promos"]).toBe("edit");
    expect(admin["/admin/settings"]).toBeUndefined();
    expect(presetAccess("editor", sections)).toEqual({ "/admin": "view" });
    expect(presetAccess("guest", sections)).toEqual({});
  });
});

describe("matrix edits", () => {
  const workspace = deriveAccessSections(GROUPS)[0];

  it("setting a whole section caps view-only pages and skips locked rows", () => {
    const access = setSectionLevel({}, workspace, "edit");
    expect(access).toEqual({ "/admin": "view", "/admin/media": "edit" });
    expect(sectionLevel(access, workspace)).toBe("edit");
  });

  it("a section with different levels reads as mixed; none removes the key", () => {
    const one = setAreaLevel({}, { key: "/admin/media", max: "edit" }, "view");
    expect(sectionLevel(one, workspace)).toBeNull();
    expect(setAreaLevel(one, { key: "/admin/media", max: "edit" }, "none")).toEqual({});
  });
});
