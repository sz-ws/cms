import type { LocalizedString } from "./i18n/localized";
import { normalizeHex, readableOn } from "./color";

// 後台主色:存在 DB(core.adminAccent,設定頁選),瀏覽器用 localStorage 當快取。
//
//   - 本機有快取就只用快取,不問 server:admin layout 最前面的
//     ADMIN_ACCENT_BOOT_SCRIPT 在畫面出來前套上,不會先閃一下預設色。
//   - 沒有快取(第一次登入、換電腦、清過資料)→ AdminAccentSync 打一次
//     GET /api/admin-accent,存進快取。
//   - 設定頁本來就載入 DB 的值;打開或存檔後(router.refresh)若跟快取不同就更新 ——
//     存檔立刻生效,別台電腦改了色,這台也會在這裡跟上,不必多查 DB。
// 預設色寫在 globals.css(--admin-accent);快取是預設色時不插 <style>。

export const ADMIN_ACCENT_STORAGE_KEY = "cms.adminAccent";
export const DEFAULT_ADMIN_ACCENT = "#5672e4";
const STYLE_ID = "cms-admin-accent";

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

interface CachedAccent {
  accent: string;
  /** 主色上的字(勾勾、徽章):存的時候算好,boot script 不必算亮度。 */
  fg: string;
}

/**
 * 畫面出來前執行的 inline script。只接受 #rrggbb(值會拼進 CSS);localStorage
 * 讀不到、被停用或內容壞掉都安靜地用預設色。CSP 目前放行 inline script
 * (next.config.ts);之後改 nonce 時這段要帶 nonce。
 */
export const ADMIN_ACCENT_BOOT_SCRIPT = `(function(){try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(ADMIN_ACCENT_STORAGE_KEY)})||"null"),h=/^#[0-9a-f]{6}$/;if(!v||!h.test(v.accent)||!h.test(v.fg)||v.accent===${JSON.stringify(DEFAULT_ADMIN_ACCENT)})return;var s=document.getElementById(${JSON.stringify(STYLE_ID)})||document.head.appendChild(document.createElement("style"));s.id=${JSON.stringify(STYLE_ID)};s.textContent=":root{--admin-accent:"+v.accent+";--admin-accent-fg:"+v.fg+"}"}catch(e){}})();`;

/** 快取的主色;沒有快取、格式不對或讀不到 localStorage 回 null(= 要問 server)。 */
export function readCachedAccent(): string | null {
  try {
    const raw = window.localStorage.getItem(ADMIN_ACCENT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedAccent>;
    return typeof value.accent === "string" ? normalizeHex(value.accent) : null;
  } catch {
    return null;
  }
}

/** 把主色畫上去(<head> 的 <style>),不動快取。預設色 = 拿掉 <style>。 */
export function paintAdminAccent(hex: string | null): void {
  const accent = hex === null ? null : normalizeHex(hex);
  const existing = document.getElementById(STYLE_ID);
  if (accent === null || accent === DEFAULT_ADMIN_ACCENT) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.head.appendChild(document.createElement("style"));
  style.id = STYLE_ID;
  style.textContent = `:root{--admin-accent:${accent};--admin-accent-fg:${readableOn(accent)}}`;
}

/**
 * 存進快取並套用。預設色也存 —— 快取的意義是「知道了,不必再問」,
 * 沒改過顏色的站台也不該每次載入都打 API。
 */
export function cacheAdminAccent(hex: string): void {
  const accent = normalizeHex(hex) ?? DEFAULT_ADMIN_ACCENT;
  paintAdminAccent(accent);
  try {
    const cached: CachedAccent = { accent, fg: readableOn(accent) };
    window.localStorage.setItem(ADMIN_ACCENT_STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // 無痕模式或被停用:這個分頁照樣換色,只是下次載入會再問一次 server。
  }
}
