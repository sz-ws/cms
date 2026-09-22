import type { LocalizedString } from "./i18n/localized";

// 後台主色:存在 DB(core.adminAccent),由「設定 → 風格」編輯,和 core.adminTheme
// 一起經 /api/admin-theme 存。套用與跨分頁同步見 lib/admin-theme.ts + AdminTheme。
// 預設色寫在 globals.css(--admin-accent)。

export const DEFAULT_ADMIN_ACCENT = "#5672e4";

export const ADMIN_ACCENT_SWATCHES: { value: string; label: LocalizedString }[] = [
  { value: DEFAULT_ADMIN_ACCENT, label: { en: "Blue", "zh-Hant": "藍" } },
  { value: "#e0457b", label: { en: "Pink", "zh-Hant": "粉紅" } },
  { value: "#d64545", label: { en: "Red", "zh-Hant": "紅" } },
  { value: "#e0732a", label: { en: "Orange", "zh-Hant": "橘" } },
  { value: "#2f9e6e", label: { en: "Green", "zh-Hant": "綠" } },
  { value: "#1f93a3", label: { en: "Teal", "zh-Hant": "青" } },
  { value: "#7b5cd6", label: { en: "Purple", "zh-Hant": "紫" } },
  { value: "#262626", label: { en: "Ink", "zh-Hant": "墨黑" } },
];
