"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  ADMIN_FONT_ATTR, ADMIN_THEME_EVENT, ADMIN_THEME_STORAGE_KEY, ADMIN_THEME_STYLE_ID, ADMIN_THEMED_ATTR,
  adminFontHref, adminThemeCss, isDefaultAdminTheme, resolveAdminAppearance, type AdminAppearance,
} from "@/lib/admin-theme";
import { AdminIconSetProvider } from "./admin-icon-set";

/** Server-rendered style is authoritative on first paint. Cache is only a
 * cross-tab notification; stale storage never overrides fresh server values. */
export function AdminTheme({ initial, children }: { initial: AdminAppearance; children?: ReactNode }) {
  const [appearance, setAppearance] = useState(initial);
  const [previous, setPrevious] = useState(initial);
  const pathname = usePathname();
  if (JSON.stringify(previous) !== JSON.stringify(initial)) {
    setPrevious(initial);
    setAppearance(initial);
  }
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const response = await fetch("/api/admin-theme", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { theme?: unknown; accent?: unknown } | null;
        if (live && request === sequence && body) setAppearance(resolveAdminAppearance(body.theme, body.accent));
      } catch { /* retain last server-confirmed theme while offline */ }
    };
    const onSaved = (event: Event) => {
      ++sequence;
      const value = (event as CustomEvent<AdminAppearance>).detail;
      if (value) setAppearance(resolveAdminAppearance(value.theme, value.accent));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ADMIN_THEME_STORAGE_KEY || event.key === "cms.adminAccent" || event.key === null) void refresh();
    };
    window.addEventListener(ADMIN_THEME_EVENT, onSaved);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    // Next preserves layouts during navigation. Revalidate on each admin route.
    void refresh();
    return () => {
      live = false;
      window.removeEventListener(ADMIN_THEME_EVENT, onSaved);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
    };
  }, [pathname]);
  const fontHref = adminFontHref(appearance.theme.font);
  const markers = {
    ...(isDefaultAdminTheme(appearance.theme) ? {} : { [ADMIN_THEMED_ATTR]: "" }),
    ...(fontHref ? { [ADMIN_FONT_ATTR]: "" } : {}),
  };
  return (
    // 側欄圖示是元件而不是 CSS,由這層把已存風格的圖示組交給 NavIcon。
    <AdminIconSetProvider value={appearance.theme.icons}>
      {/* precedence:React 放進 <head> 並去重;預設字體不載入任何外部資源。 */}
      {fontHref && <link rel="stylesheet" href={fontHref} precedence="admin-font" />}
      <style id={ADMIN_THEME_STYLE_ID} {...markers}>{adminThemeCss(appearance)}</style>
      {children}
    </AdminIconSetProvider>
  );
}
