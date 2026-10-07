import { describe, it, expect } from "vitest";
import { normalizeAdminMenu, type AdminMenuItem } from "../src/ext/admin-menu";

// 側欄項目的插槽(core-slots.ts 的 AdminSidebarItems)是上層填的。渲染前收斂一次:
// 一個寫壞的填法不能讓整個後台開不起來。

const BASE: AdminMenuItem[] = [
  { href: "/admin", title: "儀表板" },
  { href: "/admin/media", title: "媒體庫" },
];

describe("側欄項目的收斂", () => {
  it("形狀對的原樣通過,物件不換", () => {
    const folder: AdminMenuItem = { href: "/admin/ext/shop", title: "商店", section: "commerce", icon: "store", order: 3, children: [{ href: "/admin/ext/shop/returns", title: "退貨" }] };
    const menu = [...BASE, folder];
    const out = normalizeAdminMenu(menu, BASE);
    expect(out).toEqual(menu);
    expect(out[2]).toBe(folder);
  });

  it("整份不是陣列:用填之前的", () => {
    for (const bad of [null, undefined, "menu", 3, { href: "/admin" }]) {
      expect(normalizeAdminMenu(bad, BASE)).toBe(BASE);
    }
  });

  it("逐項丟掉形狀不對的,其他照常", () => {
    const out = normalizeAdminMenu(
      [BASE[0], null, "x", { href: 3, title: "壞的" }, { href: "/admin/x" }, { href: "/admin/y", title: "  " }, BASE[1]],
      BASE,
    );
    expect(out).toEqual(BASE);
  });

  it("子項也收斂;children 不是陣列就當沒有子項", () => {
    const out = normalizeAdminMenu(
      [
        { href: "/admin/ext/a", title: "A", children: [{ href: "/admin/ext/a/one", title: "一" }, { title: "沒有網址" }] },
        { href: "/admin/ext/b", title: "B", children: "nope" },
      ],
      BASE,
    );
    expect(out).toEqual([
      { href: "/admin/ext/a", title: "A", children: [{ href: "/admin/ext/a/one", title: "一" }] },
      { href: "/admin/ext/b", title: "B" },
    ]);
  });

  it("全部被丟光:用填之前的", () => {
    expect(normalizeAdminMenu([null, { title: "沒有網址" }], BASE)).toBe(BASE);
  });
});
