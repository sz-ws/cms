import { describe, it, expect } from "vitest";
import {
  buildExtensionMenu,
  safeAdminIcon,
  type MenuExtension,
} from "../src/ext/admin-menu";
import { pickActiveHref } from "../src/components/admin/nav-active";
import { defineExtension } from "../src/ext/types";
import { parseManifest } from "../src/ext/dx/manifest";

// 1.39.0:側欄分區、巢狀與自訂圖示(src/ext/admin-menu.ts、nav-active.ts)。純函式。

const resolve = (value: unknown) => (typeof value === "string" ? value : undefined);
const page = (slug: string, title: string) => ({ slug, title });

const ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v10H2z"/></svg>';

describe("buildExtensionMenu", () => {
  it("keeps a single-page extension as one link in the content section", () => {
    const items = buildExtensionMenu(
      [{ id: "gallery", name: "相片集", icon: "images", adminPages: [page("", "相片")] }],
      resolve,
      "總覽",
    );
    expect(items).toEqual([
      { href: "/admin/ext/gallery", title: "相片", icon: "images", section: "content", order: undefined },
    ]);
  });

  it("folds a multi-page extension into a folder named after the extension", () => {
    const [shop] = buildExtensionMenu(
      [
        {
          id: "shop",
          name: "商店",
          menu: { section: "commerce" },
          adminPages: [page("", "訂單"), page("verify", "對帳佇列"), { ...page("hidden", "隱藏"), showInMenu: false }],
        },
      ],
      resolve,
      "總覽",
    );
    expect(shop.title).toBe("商店");
    expect(shop.section).toBe("commerce");
    expect(shop.href).toBe("/admin/ext/shop");
    expect(shop.children?.map((c) => c.title)).toEqual(["訂單", "對帳佇列"]);
  });

  it("nests an extension under its declared parent, after the parent's own pages", () => {
    const exts: MenuExtension[] = [
      { id: "banktransfer", name: "銀行轉帳", menu: { parent: "shop" }, adminPages: [page("", "銀行轉帳")] },
      { id: "shop", name: "商店", adminPages: [page("", "訂單")] },
    ];
    const items = buildExtensionMenu(exts, resolve, "總覽");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("商店");
    expect(items[0].children?.map((c) => c.href)).toEqual([
      "/admin/ext/shop",
      "/admin/ext/banktransfer",
    ]);
  });

  it("renames a child that repeats the folder title", () => {
    const [ops] = buildExtensionMenu(
      [
        { id: "shop-operations", name: "商城營運", adminPages: [page("", "商城營運")] },
        { id: "fulfillment", name: "配送", menu: { parent: "shop-operations" }, adminPages: [page("", "出貨佇列")] },
      ],
      resolve,
      "總覽",
    );
    expect(ops.children?.map((c) => c.title)).toEqual(["總覽", "出貨佇列"]);
  });

  it("falls back to top level when the parent is missing or has no pages", () => {
    const items = buildExtensionMenu(
      [
        { id: "wallet", name: "錢包" },
        { id: "dealer", name: "經銷", menu: { parent: "wallet" }, adminPages: [page("", "經銷管理")] },
        { id: "referral", name: "推薦", menu: { parent: "not-installed" }, adminPages: [page("", "推薦分潤")] },
      ],
      resolve,
      "總覽",
    );
    expect(items.map((i) => i.title)).toEqual(["經銷管理", "推薦分潤"]);
  });

  it("does not hide extensions whose parents form a cycle", () => {
    const items = buildExtensionMenu(
      [
        { id: "alpha", name: "A", menu: { parent: "beta" }, adminPages: [page("", "A")] },
        { id: "beta", name: "B", menu: { parent: "alpha" }, adminPages: [page("", "B")] },
      ],
      resolve,
      "總覽",
    );
    expect(items.map((i) => i.href)).toEqual(["/admin/ext/alpha", "/admin/ext/beta"]);
  });

  it("attaches a grandchild to the root folder (one level of nesting)", () => {
    const [root] = buildExtensionMenu(
      [
        { id: "root", name: "Root", adminPages: [page("", "Root page")] },
        { id: "mid", name: "Mid", menu: { parent: "root" }, adminPages: [page("", "Mid page")] },
        { id: "leaf", name: "Leaf", menu: { parent: "mid" }, adminPages: [page("", "Leaf page")] },
      ],
      resolve,
      "Overview",
    );
    expect(root.children?.map((c) => c.title)).toEqual(["Root page", "Mid page", "Leaf page"]);
    expect(root.children?.every((c) => c.children === undefined)).toBe(true);
  });

  it("sorts by order and keeps registry order for ties", () => {
    const items = buildExtensionMenu(
      [
        { id: "late", name: "Late", menu: { order: 50 }, adminPages: [page("", "Late")] },
        { id: "plain-a", name: "A", adminPages: [page("", "A")] },
        { id: "first", name: "First", menu: { order: 10 }, adminPages: [page("", "First")] },
        { id: "plain-b", name: "B", adminPages: [page("", "B")] },
      ],
      resolve,
      "Overview",
    );
    expect(items.map((i) => i.title)).toEqual(["First", "Late", "A", "B"]);
  });
});

describe("admin icons", () => {
  it("passes tokens through and keeps guarded svg", () => {
    expect(safeAdminIcon("truck")).toBe("truck");
    expect(safeAdminIcon(ICON_SVG)).toBe(ICON_SVG);
    expect(safeAdminIcon(undefined)).toBeUndefined();
  });

  it("drops svg that fails svg-guard", () => {
    expect(safeAdminIcon('<svg onload="alert(1)"><path d="M0 0"/></svg>')).toBeUndefined();
    expect(safeAdminIcon("<svg><image/></svg>")).toBeUndefined();
  });

  it("validates icon and menu in defineExtension", () => {
    const base = { id: "demo", name: "Demo", version: "0.1.0", coreApi: "^1.39.0" };
    expect(() => defineExtension({ ...base, icon: ICON_SVG, menu: { section: "commerce", parent: "shop", order: 5 } })).not.toThrow();
    expect(() => defineExtension({ ...base, icon: "<svg><script>alert(1)</script></svg>" })).toThrow(/icon/);
    expect(() => defineExtension({ ...base, menu: { parent: "demo" } })).toThrow(/nest under itself/);
    // @ts-expect-error — unknown section
    expect(() => defineExtension({ ...base, menu: { section: "sidebar" } })).toThrow();
  });

  it("validates icon and menu in declarative manifests", () => {
    const base = { kind: "declarative", id: "notes", name: "Notes", version: "1.0.0", coreApi: "^1.39.0" };
    expect(parseManifest({ ...base, icon: ICON_SVG, menu: { section: "content" } }).ok).toBe(true);
    expect(parseManifest({ ...base, icon: '<svg><path d="M0 0" onclick="x()"/></svg>' }).ok).toBe(false);
    expect(parseManifest({ ...base, menu: { parent: "notes" } }).ok).toBe(false);
    expect(parseManifest({ ...base, menu: { depth: 2 } }).ok).toBe(false);
  });
});

describe("pickActiveHref", () => {
  const items = [
    { href: "/admin", kind: "core" },
    {
      href: "/admin/ext/shop",
      kind: "extension",
      children: [
        { href: "/admin/ext/shop", kind: "extension" },
        { href: "/admin/ext/shop/verify", kind: "extension" },
      ],
    },
    { href: "/admin/extensions?tab=browse", kind: "shop" },
    { href: "/admin/extensions", kind: "shop" },
  ];

  it("picks only the longest matching page", () => {
    expect(pickActiveHref(items, "/admin/ext/shop/verify", null)).toBe("/admin/ext/shop/verify");
    expect(pickActiveHref(items, "/admin/ext/shop", null)).toBe("/admin/ext/shop");
    expect(pickActiveHref(items, "/admin/ext/shop/orders/123", null)).toBe("/admin/ext/shop");
  });

  it("matches the dashboard exactly and the store entries by tab", () => {
    expect(pickActiveHref(items, "/admin", null)).toBe("/admin");
    expect(pickActiveHref(items, "/admin/media", null)).toBeNull();
    expect(pickActiveHref(items, "/admin/extensions", "browse")).toBe("/admin/extensions?tab=browse");
    expect(pickActiveHref(items, "/admin/extensions", null)).toBe("/admin/extensions");
  });
});
