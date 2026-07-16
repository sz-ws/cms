import type { CSSProperties, ReactNode } from "react";
import type { DeclarativeTheme } from "./manifest";
import { cachedExtStylesheet } from "./content-cache";

// 1.8.0:public 頁面的 theme scope。把 manifest.theme 的 tokens 宣告成 CSS 自訂屬性
// (只宣告有給的),掛在一個 data-ext="<id>" 的包裹層上,供泛用 public views 以
// var(--ext-*, <current>) 取用(fallback 皆為現行 Paper & Ink 值,tokens 只做 tint)。
//
// 安全:theme 值已於 parseManifest(themeSchema)通過注入安全驗證(hex/oklch/rgb/hsl 或
// <n>px|rem,且不含 ; { } < > " ');此處僅把已驗證的字串放進 style 物件,不再拼接。
// admin 頁完全不經過此 scope(theme 只影響 public)。
//
// 1.8.0 stylesheet:同一 data-ext="<id>" 包裹層上,若該 extension 存有已驗證的 CSS,
// server-side 注入 <style>,並以 CSS nesting 包成 `[data-ext="<id>"] { <sheet> }` —— 只
// 作用於此 extension 自己的 public 頁面。extId 受 ID_RE 約束(僅小寫字母/數字/連字號),
// 故放進屬性選擇器與 <style> 文字皆安全;CSS 只進 <style> 文字節點(不進 HTML 屬性),
// style-tag breakout(`</`)已於 validateStylesheet 擋掉,故此處不再逃逸/跳脫。
//
// v1 限制:sheet 被包在 `[data-ext] { … }` 的 CSS nesting 之下,故 top-level at-rules
// (@font-face / @keyframes / @media 於此語境雖多數瀏覽器容許巢狀,但 @font-face 這類
// 不可巢狀者)不會生效。作者若需 @font-face,v1 尚不支援。

/** 只把「有宣告」的 token 映成 CSS 變數;沒宣告的不寫入,讓 view 端 fallback 生效。 */
function themeVars(theme: DeclarativeTheme | undefined): CSSProperties | undefined {
  if (!theme) return undefined;
  const vars: Record<string, string> = {};
  if (theme.accent) vars["--ext-accent"] = theme.accent;
  if (theme.background) vars["--ext-bg"] = theme.background;
  if (theme.muted) vars["--ext-muted"] = theme.muted;
  if (theme.radius) vars["--ext-radius"] = theme.radius;
  return Object.keys(vars).length > 0 ? (vars as CSSProperties) : undefined;
}

export interface ExtThemeScopeProps {
  extId: string;
  theme?: DeclarativeTheme;
  children: ReactNode;
}

export function ExtThemeScope({ extId, theme, children }: ExtThemeScopeProps) {
  const style = themeVars(theme);
  // background 消費在同一層(--ext-bg 宣告與取用同元素;未宣告時 fallback transparent)。
  return (
    <div
      data-ext={extId}
      style={{ ...style, background: "var(--ext-bg, transparent)" }}
    >
      {/* 非同步子元件:載入並注入該 extension 的 scoped stylesheet(有才注入)。 */}
      <ExtStyleTag extId={extId} />
      {children}
    </div>
  );
}

/**
 * async server component:讀取已驗證的 stylesheet(tagged cache;失敗降級為 null),
 * 有 sheet 才 render <style>,並以 CSS nesting 包成 `[data-ext="<id>"] { <sheet> }`
 * scoped 於外層 wrapper。無 sheet(或讀取失敗)→ 不 render → 頁面照常無自訂樣式。
 */
async function ExtStyleTag({ extId }: { extId: string }) {
  const sheet = await cachedExtStylesheet(extId);
  if (!sheet) return null;
  // CSS 進 <style> 文字節點(單一 string child,React 原樣輸出不逃逸);breakout(`</`)
  // 已於 validateStylesheet 拒絕,extId 受 ID_RE 約束,故此處無需再跳脫。
  const scoped = `[data-ext="${extId}"] {\n${sheet}\n}`;
  return <style>{scoped}</style>;
}
