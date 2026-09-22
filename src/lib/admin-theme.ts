import { z } from "zod";
import { DEFAULT_ADMIN_ACCENT } from "./admin-accent";
import { normalizeHex, readableOn, relativeLuminance } from "./color";

const hex = z.string().regex(/^#[0-9a-f]{6}$/);

/** 後台字體。預設 = 原本的 Geist + 昭源黑體(自架);其他從 Google Fonts 載入,
 * 只在選了之後才發請求。family 是整串 font-family,不接受使用者輸入。 */
export const ADMIN_FONTS = [
  { id: "default", name: { en: "Chiron Hei", "zh-Hant": "昭源黑體" }, family: 'var(--font-geist), "Chiron Hei HK", ui-sans-serif, system-ui, sans-serif', google: null },
  { id: "noto-sans", name: { en: "Noto Sans", "zh-Hant": "思源黑體" }, family: '"Noto Sans TC", ui-sans-serif, system-ui, sans-serif', google: "Noto+Sans+TC:wght@400;500;600;700" },
  { id: "noto-serif", name: { en: "Noto Serif", "zh-Hant": "思源宋體" }, family: '"Noto Serif TC", ui-serif, Georgia, serif', google: "Noto+Serif+TC:wght@400;500;600;700" },
  { id: "chiron-sung", name: { en: "Chiron Sung", "zh-Hant": "昭源宋體" }, family: '"Chiron Sung HK", ui-serif, Georgia, serif', google: "Chiron+Sung+HK:wght@400;500;600;700" },
  { id: "wenkai", name: { en: "LXGW WenKai", "zh-Hant": "霞鶩文楷" }, family: '"LXGW WenKai TC", ui-serif, serif', google: "LXGW+WenKai+TC:wght@400;700" },
] as const;
export type AdminFontId = (typeof ADMIN_FONTS)[number]["id"];
const FONT_IDS = ADMIN_FONTS.map((font) => font.id) as [AdminFontId, ...AdminFontId[]];

export function adminFont(id: AdminFontId) {
  return ADMIN_FONTS.find((font) => font.id === id) ?? ADMIN_FONTS[0];
}

/** Google Fonts 的 stylesheet;預設字體回 null(不發任何外部請求)。 */
export function adminFontHref(id: AdminFontId): string | null {
  const { google } = adminFont(id);
  return google ? `https://fonts.googleapis.com/css2?family=${google}&display=swap` : null;
}

/** 側欄圖示:solid = Heroicons 16 實心(預設),outline = Lucide 線條(對照 adminNavIcons.tsx)。 */
export const ADMIN_ICON_SETS = ["solid", "outline"] as const;
export type AdminIconSet = (typeof ADMIN_ICON_SETS)[number];

export const adminThemeSchema = z.strictObject({
  version: z.literal(1),
  background: hex,
  surface: hex,
  ink: hex,
  radius: z.enum(["sharp", "soft", "round"]),
  elevation: z.enum(["flat", "line", "soft"]),
  // 後加的欄位:舊的已存風格沒有它,讀進來補預設。
  font: z.enum(FONT_IDS).default("default"),
  icons: z.enum(ADMIN_ICON_SETS).default("solid"),
}).superRefine((theme, ctx) => {
  // V1 is a light theme contract. Reject unreadable combinations at the API,
  // rather than letting a saved preference make its own editor unusable.
  for (const key of ["background", "surface"] as const) {
    if (relativeLuminance(theme[key]) < 0.55 || contrast(theme.ink, theme[key]) < 7) {
      ctx.addIssue({ code: "custom", path: [key], message: "insufficient_contrast" });
    }
  }
});

export type AdminTheme = z.infer<typeof adminThemeSchema>;
export interface AdminAppearance { theme: AdminTheme; accent: string }
export const DEFAULT_ADMIN_THEME: AdminTheme = {
  version: 1, background: "#fbfaf9", surface: "#ffffff", ink: "#000000",
  radius: "soft", elevation: "soft", font: "default", icons: "solid",
};
export const ADMIN_THEME_STORAGE_KEY = "cms.adminTheme.v1";
export const ADMIN_THEME_EVENT = "cms:admin-theme";
export const ADMIN_THEME_STYLE_ID = "cms-admin-theme";
/** 自訂風格時 AdminTheme 的 <style> 帶這個屬性;admin-theme.css 的橋接與 `admin:`
 * 變體只認它(`#cms-admin-theme[data-themed]`)。預設風格不帶 = 原本的樣子。 */
export const ADMIN_THEMED_ATTR = "data-themed";
/** 選了非預設字體時多帶這個,admin-theme.css 才把 body 換字。 */
export const ADMIN_FONT_ATTR = "data-admin-font";

export const ADMIN_THEME_PRESETS: {
  id: string; name: { en: string; "zh-Hant": string }; appearance: AdminAppearance;
}[] = [
  { id: "paper", name: { en: "Paper & Ink", "zh-Hant": "紙與墨" }, appearance: { theme: DEFAULT_ADMIN_THEME, accent: DEFAULT_ADMIN_ACCENT } },
  { id: "sage", name: { en: "Sage", "zh-Hant": "鼠尾草" }, appearance: { theme: { version: 1, background: "#e8eee7", surface: "#f8fbf5", ink: "#20362b", radius: "round", elevation: "soft", font: "default", icons: "solid" }, accent: "#387653" } },
  { id: "clay", name: { en: "Clay", "zh-Hant": "暖陶" }, appearance: { theme: { version: 1, background: "#f3e8db", surface: "#fffaf2", ink: "#422c22", radius: "soft", elevation: "line", font: "default", icons: "solid" }, accent: "#a24932" } },
  { id: "atelier", name: { en: "Atelier", "zh-Hant": "工坊" }, appearance: { theme: { version: 1, background: "#eae9f4", surface: "#faf9ff", ink: "#29233d", radius: "sharp", elevation: "flat", font: "default", icons: "solid" }, accent: "#7054b3" } },
];

export function contrast(a: string, b: string): number {
  const x = relativeLuminance(a), y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function resolveAdminAppearance(theme: unknown, accent: unknown): AdminAppearance {
  const parsed = adminThemeSchema.safeParse(theme);
  return {
    theme: parsed.success ? parsed.data : { ...DEFAULT_ADMIN_THEME },
    accent: typeof accent === "string" ? normalizeHex(accent) ?? DEFAULT_ADMIN_ACCENT : DEFAULT_ADMIN_ACCENT,
  };
}

/** 紙與墨 = 改版前的後台。預設風格不寫任何主題變數,元件走各自原本的 fallback。 */
export function isDefaultAdminTheme(theme: AdminTheme): boolean {
  return (Object.keys(DEFAULT_ADMIN_THEME) as (keyof AdminTheme)[]).every((key) => theme[key] === DEFAULT_ADMIN_THEME[key]);
}

/** Safe declarations only; never accepts CSS, selectors or arbitrary keys. */
export function adminThemeVariables(input: AdminAppearance): Record<string, string> {
  const { theme, accent } = resolveAdminAppearance(input.theme, input.accent);
  // globals.css 的 :root 裡這幾個 token 引用 --admin-accent,在 :root 就已經算成預設藍;
  // 主色宣告在 body,所以要跟著重宣告一次(改版前的主色直接寫在 :root,不需要)。
  const accentTokens: Record<string, string> = {
    "--admin-accent": accent,
    "--admin-accent-fg": readableOn(accent),
    "--accent-blue": "var(--admin-accent)",
    "--ring": "var(--admin-accent)",
    "--chart-1": "var(--admin-accent)",
    "--sidebar-primary": "var(--admin-accent)",
    "--sidebar-primary-foreground": "var(--admin-accent-fg)",
    "--sidebar-primary-fg": "var(--admin-accent-fg)",
    "--sidebar-ring": "var(--admin-accent)",
  };
  if (isDefaultAdminTheme(theme)) return accentTokens;
  const scale = { sharp: 0, soft: 1, round: 1.65 }[theme.radius];
  const line = "0 0 0 1px color-mix(in srgb,var(--ink) 10%,transparent)";
  // 柔和 = 各元件原本的陰影:initial 讓 var(--admin-shadow-*, 原本的值) 走 fallback,
  // 也蓋掉外層(已存的風格)傳下來的值 —— 預覽區塊靠這個。
  // 平面用透明陰影而不是 none:Tailwind 把 ring 與陰影組成同一條 box-shadow,
  // 列表裡出現 none 整條失效,選單會連 1px 邊框都不見。
  const shadow = (soft: string) => theme.elevation === "flat" ? "0 0 #0000" : theme.elevation === "line" ? line : soft;
  return {
    ...accentTokens,
    "--admin-ground": theme.background,
    "--admin-surface": theme.surface,
    "--admin-ink": theme.ink,
    "--admin-radius-scale": String(scale),
    "--admin-radius-control": `${8 * scale}px`,
    "--admin-radius-card": `${14 * scale}px`,
    "--admin-radius-panel": `${20 * scale}px`,
    "--admin-shadow-card": shadow("initial"),
    "--admin-shadow-panel": shadow("initial"),
    // 預設字體寫 initial:預覽區塊要蓋掉外層已存的字體。
    "--admin-font": theme.font === "default" ? "initial" : adminFont(theme.font).family,
  };
}

export function adminThemeCss(appearance: AdminAppearance): string {
  const declarations = Object.entries(adminThemeVariables(appearance)).map(([key, value]) => `${key}:${value}`).join(";");
  // body scope includes portalled menus/dialogs. :has automatically stops
  // matching when Next navigates from the authenticated admin to a public page.
  return `body:has([data-admin-surface]){${declarations}}`;
}

export function cacheAdminAppearance(appearance: AdminAppearance): void {
  try { localStorage.setItem(ADMIN_THEME_STORAGE_KEY, JSON.stringify(appearance)); } catch { /* storage is optional */ }
  window.dispatchEvent(new CustomEvent(ADMIN_THEME_EVENT, { detail: appearance }));
}
