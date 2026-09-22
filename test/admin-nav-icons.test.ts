import { describe, expect, it } from "vitest";
import { SUPPORTED_ADMIN_ICON_TOKENS, iconForNavItem } from "../src/components/admin/adminNavIcons";

// 側欄兩套圖示:每個代號在實心(Heroicons)與線條(Lucide)都要有對應,
// 預設仍是原本的實心那一套。
describe("admin sidebar icon sets", () => {
  const item = (icon?: string, href = "/admin/ext/x", kind: "core" | "extension" | "shop" = "extension") =>
    ({ href, title: "x", kind, icon }) as Parameters<typeof iconForNavItem>[0];

  it.each(SUPPORTED_ADMIN_ICON_TOKENS)("token %s has a solid and an outline glyph", (token) => {
    const solid = iconForNavItem(item(token), "solid");
    const outline = iconForNavItem(item(token), "outline");
    expect(solid).toBeTruthy();
    expect(outline).toBeTruthy();
    expect(outline).not.toBe(solid);
  });

  it("defaults to the solid set and covers core routes and guesses in both", () => {
    expect(iconForNavItem(item("truck"))).toBe(iconForNavItem(item("truck"), "solid"));
    for (const href of ["/admin", "/admin/media", "/admin/settings", "/admin/users", "/admin/agent"]) {
      expect(iconForNavItem(item(undefined, href, "core"), "outline")).not.toBe(iconForNavItem(item(undefined, href, "core"), "solid"));
    }
    expect(iconForNavItem(item(undefined, "/admin/ext/gallery"), "outline")).toBe(iconForNavItem(item("image"), "outline"));
  });
});
