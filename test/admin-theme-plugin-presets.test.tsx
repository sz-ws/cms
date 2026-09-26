import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.57.0:插件提供的後台預設風格(manifest / code extension 的 appearances)。
// 同一個 adminThemeSchema 把關;出現在「從一款風格開始」內建預設之後,標上插件名稱。

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

import { parseManifest } from "../src/ext/dx/manifest";
import { defineExtension } from "../src/ext/types";
import {
  ADMIN_THEME_PRESETS,
  DEFAULT_ADMIN_THEME,
  activePresetKey,
  applyPreset,
  pluginAdminPresets,
  presetOptions,
  resolveAdminAppearance,
  type ExtensionAppearance,
} from "../src/lib/admin-theme";
import { AdminThemeEditor } from "@/components/admin/AdminThemeEditor";

const warm: ExtensionAppearance = {
  id: "warm",
  name: { en: "Warm counter", "zh-Hant": "暖櫃台" },
  description: { en: "Soft paper tones", "zh-Hant": "柔和的紙色" },
  theme: { version: 1, background: "#f4ede2", surface: "#fffaf3", ink: "#3a2a20", radius: "round", elevation: "line" },
  accent: "#b5532f",
};
const plain: ExtensionAppearance = {
  id: "plain",
  name: "Plain",
  theme: { version: 1, background: "#f5f5f5", surface: "#ffffff", ink: "#111111", radius: "sharp", elevation: "flat", font: "noto-serif", icons: "outline" },
};

const manifest = (appearances: unknown, coreApi = "^1.57.0") => ({
  kind: "declarative" as const,
  id: "brand-kit",
  name: { en: "Brand kit", "zh-Hant": "品牌套件" },
  version: "1.0.0",
  coreApi,
  appearances,
});

const codeExt = (appearances: ExtensionAppearance[], coreApi = "^1.57.0") => ({
  id: "members",
  name: { en: "Members", "zh-Hant": "會員" },
  version: "1.0.0",
  coreApi,
  appearances,
});

describe("manifest appearances", () => {
  it("accepts presets validated by the admin style schema and fills font and icons", () => {
    const result = parseManifest(manifest([warm, plain]));
    expect(result.ok).toBe(true);
    expect(result.manifest?.appearances?.[0].theme).toEqual({ ...warm.theme, font: "default", icons: "solid" });
    expect(result.manifest?.appearances?.[1].theme.font).toBe("noto-serif");
  });

  it("rejects unreadable colours, CSS in values, unknown keys and a bad accent", () => {
    for (const theme of [
      { ...warm.theme, surface: "#222222" },
      { ...warm.theme, ink: "#eeeeee" },
      { ...warm.theme, background: "#fff;}body{display:none" },
      { ...warm.theme, radius: "12px" },
      { ...warm.theme, font: "Comic Sans" },
      { ...warm.theme, css: "body{}" },
      { ...warm.theme, version: 2 },
    ]) {
      expect(parseManifest(manifest([{ ...warm, theme }])).ok).toBe(false);
    }
    expect(parseManifest(manifest([{ ...warm, accent: "red" }])).ok).toBe(false);
    expect(parseManifest(manifest([{ ...warm, stylesheet: "style.css" }])).ok).toBe(false);
    expect(parseManifest(manifest([{ ...warm, id: "Warm Style" }])).ok).toBe(false);
  });

  it("allows at most six, with unique ids", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...warm, id: `style-${i}` }));
    expect(parseManifest(manifest(six)).ok).toBe(true);
    expect(parseManifest(manifest([...six, { ...warm, id: "style-6" }])).ok).toBe(false);
    const dup = parseManifest(manifest([warm, { ...plain, id: "warm" }]));
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('duplicate appearance id "warm"');
  });

  it("requires coreApi ^1.57.0", () => {
    const old = parseManifest(manifest([warm], "^1.56.0"));
    expect(old.ok).toBe(false);
    expect(old.error).toContain('appearances requires coreApi "^1.57.0"');
  });
});

describe("code extension appearances", () => {
  it("accepts valid presets", () => {
    expect(() => defineExtension(codeExt([warm, plain]))).not.toThrow();
  });

  it("rejects a bad theme, too many, duplicate ids and an old coreApi", () => {
    expect(() => defineExtension(codeExt([{ ...warm, theme: { ...warm.theme, surface: "#000000" } }]))).toThrow(/insufficient_contrast/);
    expect(() => defineExtension(codeExt([{ ...warm, accent: "#B5532F" }]))).toThrow(/accent/);
    expect(() => defineExtension(codeExt(Array.from({ length: 7 }, (_, i) => ({ ...warm, id: `s${i}` }))))).toThrow(/appearances/);
    expect(() => defineExtension(codeExt([warm, { ...plain, id: "warm" }]))).toThrow(/duplicate appearance id/);
    expect(() => defineExtension(codeExt([warm], "^1.56.0"))).toThrow(/appearances requires coreApi/);
  });
});

describe("plugin presets in the style editor", () => {
  const enabled = [
    { id: "catalog", name: "Catalog" },
    { id: "members", name: { en: "Members", "zh-Hant": "會員" }, appearances: [warm] },
    {
      id: "brand-kit",
      name: "Brand kit",
      // code extension 的 defineExtension 不回傳 parse 過的值:壞掉的一組略過,其他照常。
      appearances: [plain, { ...warm, id: "broken", theme: { ...warm.theme, ink: "#ffffff" } }],
    },
  ];

  it("collects enabled plugins' presets in order, resolved for the locale", () => {
    const presets = pluginAdminPresets(enabled, "zh-Hant");
    expect(presets.map((preset) => preset.key)).toEqual(["members:warm", "brand-kit:plain"]);
    expect(presets[0]).toMatchObject({ name: "暖櫃台", description: "柔和的紙色", plugin: "會員", accent: "#b5532f" });
    expect(presets[0].theme).toEqual({ ...warm.theme, font: "default", icons: "solid" });
    expect(presets[1]).not.toHaveProperty("accent");
    expect(pluginAdminPresets(enabled, "en")[0]).toMatchObject({ name: "Warm counter", plugin: "Members" });
  });

  it("lists built-in presets first and applies a plugin preset like a built-in", () => {
    const options = presetOptions("zh-Hant", pluginAdminPresets(enabled, "zh-Hant"));
    expect(options.map((option) => option.key)).toEqual([...ADMIN_THEME_PRESETS.map((preset) => preset.id), "members:warm", "brand-kit:plain"]);
    const draft = resolveAdminAppearance(undefined, "#e0457b");
    const warmOption = options.find((option) => option.key === "members:warm")!;
    const applied = applyPreset(warmOption, draft);
    expect(applied).toEqual({ theme: { ...warm.theme, font: "default", icons: "solid" }, accent: "#b5532f" });
    expect(activePresetKey(options, applied)).toBe("members:warm");
    // 沒寫主色的保留目前的主色。
    const plainApplied = applyPreset(options.find((option) => option.key === "brand-kit:plain")!, draft);
    expect(plainApplied.accent).toBe("#e0457b");
    expect(activePresetKey(options, plainApplied)).toBe("brand-kit:plain");
    // 紙與墨仍只在原本的主色下算選中。
    expect(activePresetKey(options, resolveAdminAppearance(undefined, undefined))).toBe("paper");
    expect(activePresetKey(options, draft)).toBeUndefined();
  });

  it("renders the same editor as before when no plugin provides a preset", () => {
    const initial = resolveAdminAppearance(undefined, undefined);
    const before = renderToStaticMarkup(createElement(AdminThemeEditor, { initial }));
    expect(renderToStaticMarkup(createElement(AdminThemeEditor, { initial, pluginPresets: [] }))).toBe(before);
    expect(before).not.toContain("提供");
    expect(before.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("shows plugin presets after the built-ins, labelled with the plugin name", () => {
    const pluginPresets = pluginAdminPresets(enabled, "zh-Hant");
    const initial = { theme: { ...DEFAULT_ADMIN_THEME, ...warm.theme }, accent: "#b5532f" };
    const html = renderToStaticMarkup(createElement(AdminThemeEditor, { initial, pluginPresets }));
    const order = ["紙與墨", "工坊", "暖櫃台", "Plain"].map((name) => html.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("會員 提供");
    expect(html).toContain("Brand kit 提供");
    expect(html).toContain('title="柔和的紙色"');
    expect(html).not.toContain("broken");
    // 已存的就是插件那一組 → 那張卡是選中的,內建的都不是。
    const pressed = [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain("暖櫃台");
  });

  it("keeps a saved plugin style when the plugin is disabled", () => {
    const saved = { theme: { ...DEFAULT_ADMIN_THEME, ...warm.theme }, accent: "#b5532f" };
    const html = renderToStaticMarkup(createElement(AdminThemeEditor, { initial: saved, pluginPresets: [] }));
    expect(html).not.toContain("暖櫃台");
    expect(html).not.toContain('aria-pressed="true"');
    // 設定值照舊:背景、圓角、層次都還在編輯器裡。
    expect(html).toContain("#f4ede2");
  });
});
