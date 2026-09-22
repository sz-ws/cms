import { describe, expect, it } from "vitest";
import { ADMIN_THEME_PRESETS, DEFAULT_ADMIN_THEME, adminFontHref, adminThemeSchema, adminThemeCss, adminThemeVariables, contrast, isDefaultAdminTheme, resolveAdminAppearance } from "../src/lib/admin-theme";
import { readableOn } from "../src/lib/color";
import { validateSettingValue } from "../src/lib/setting-validation";

describe("admin style contract", () => {
  it("keeps legacy accent and old sites without a theme usable", () => {
    expect(resolveAdminAppearance(undefined, "#aabbcc")).toEqual({ theme: DEFAULT_ADMIN_THEME, accent: "#aabbcc" });
    expect(resolveAdminAppearance({ version: 999 }, null).theme).toEqual(DEFAULT_ADMIN_THEME);
  });
  it.each(ADMIN_THEME_PRESETS)("preset $id has readable colors and a safe accent foreground", ({ appearance }) => {
    expect(adminThemeSchema.safeParse(appearance.theme).success).toBe(true);
    const vars = adminThemeVariables(appearance);
    // 主色上的字沿用改版前的規則(readableOn),預設藍上仍是白字。
    expect(vars["--admin-accent-fg"]).toBe(readableOn(appearance.accent));
    expect(contrast(appearance.accent, vars["--admin-accent-fg"])).toBeGreaterThanOrEqual(3);
  });
  it("rejects unreadable colors, arbitrary CSS and unsupported values through both settings paths", () => {
    for (const change of [
      { surface: "#000000" }, { ink: "#ffffff" }, { surface: "#ffffff;}body{display:none" },
      { version: 2 }, { radius: "9999px" }, { elevation: "url(https://example.test)" }, { extra: "css" },
    ]) {
      const value = { ...DEFAULT_ADMIN_THEME, ...change };
      expect(adminThemeSchema.safeParse(value).success).toBe(false);
      expect(validateSettingValue({ key: "core.adminTheme", type: "textarea" }, value)).toBe("invalid_theme");
    }
    expect(validateSettingValue({ key: "core.adminTheme", type: "textarea" }, null)).toBeNull();
  });
  it("scopes styles to the admin body including portals, never public :root", () => {
    const css = adminThemeCss(ADMIN_THEME_PRESETS[1].appearance);
    expect(css).toMatch(/^body:has\(\[data-admin-surface\]\)\{/);
    expect(css).not.toContain(":root");
    const invalid = { ...ADMIN_THEME_PRESETS[0].appearance, theme: { ...DEFAULT_ADMIN_THEME, surface: "</style><script>" } };
    expect(adminThemeCss(invalid)).not.toContain("<");
  });
  it("changes real radius and depth tokens and restores the default", () => {
    const sharp = adminThemeVariables(ADMIN_THEME_PRESETS[3].appearance);
    const round = adminThemeVariables(ADMIN_THEME_PRESETS[1].appearance);
    expect(sharp["--admin-radius-control"]).toBe("0px");
    expect(sharp["--admin-shadow-card"]).toBe("0 0 #0000");
    expect(parseFloat(round["--admin-radius-panel"])).toBeGreaterThan(parseFloat(round["--admin-radius-card"]));
    expect(round["--admin-shadow-card"]).toBe("initial");
  });
  it("reads styles saved before fonts existed, and loads Google Fonts only for a chosen font", () => {
    const withoutFont = (theme: object) => Object.fromEntries(Object.entries(theme).filter(([key]) => key !== "font"));
    expect(resolveAdminAppearance(withoutFont(ADMIN_THEME_PRESETS[2].appearance.theme), "#a24932").theme.font).toBe("default");
    expect(isDefaultAdminTheme(resolveAdminAppearance(withoutFont(DEFAULT_ADMIN_THEME), null).theme)).toBe(true);
    expect(adminFontHref("default")).toBeNull();
    expect(adminFontHref("noto-serif")).toBe("https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;600;700&display=swap");
    const serif = adminThemeVariables({ ...ADMIN_THEME_PRESETS[0].appearance, theme: { ...DEFAULT_ADMIN_THEME, font: "noto-serif" } });
    expect(serif["--admin-font"]).toContain('"Noto Serif TC"');
    expect(adminThemeVariables(ADMIN_THEME_PRESETS[1].appearance)["--admin-font"]).toBe("initial");
    expect(adminThemeSchema.safeParse({ ...DEFAULT_ADMIN_THEME, font: "Comic Sans" }).success).toBe(false);
  });
  it("keeps solid sidebar icons by default and treats outline as a custom style", () => {
    const withoutIcons = Object.fromEntries(Object.entries(DEFAULT_ADMIN_THEME).filter(([key]) => key !== "icons"));
    expect(resolveAdminAppearance(withoutIcons, null).theme.icons).toBe("solid");
    expect(isDefaultAdminTheme({ ...DEFAULT_ADMIN_THEME, icons: "outline" })).toBe(false);
    expect(adminThemeSchema.safeParse({ ...DEFAULT_ADMIN_THEME, icons: "emoji" }).success).toBe(false);
  });
  it("paper & ink writes only the accent, so every component keeps its original look", () => {
    const vars = adminThemeVariables(resolveAdminAppearance(null, "#e0457b"));
    expect(Object.keys(vars).filter((key) => /^--admin-(ground|surface|ink|radius|shadow)/.test(key))).toEqual([]);
    expect(vars["--admin-accent"]).toBe("#e0457b");
    expect(vars["--ring"]).toBe("var(--admin-accent)");
    expect(adminThemeVariables(ADMIN_THEME_PRESETS[1].appearance)["--admin-ground"]).toBe("#e8eee7");
  });
});
