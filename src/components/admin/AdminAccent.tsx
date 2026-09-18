"use client";

import { useEffect } from "react";
import { normalizeHex } from "@/lib/color";
import {
  ADMIN_ACCENT_STORAGE_KEY,
  DEFAULT_ADMIN_ACCENT,
  cacheAdminAccent,
  paintAdminAccent,
  readCachedAccent,
} from "@/lib/admin-accent";

// 後台主色的 client 端(快取規則見 lib/admin-accent.ts)。兩個元件都不畫東西。

/**
 * 掛在 admin layout。本機有快取:照快取套(用前端路由從登入頁進來時 boot script
 * 不會跑,這裡補上),不問 server。沒有快取:問一次 GET /api/admin-accent 再存起來。
 * 別的分頁改了快取(設定頁存檔),這個分頁跟著換。
 */
export function AdminAccentSync() {
  useEffect(() => {
    const cached = readCachedAccent();
    if (cached) {
      paintAdminAccent(cached);
      return;
    }
    let live = true;
    fetch("/api/admin-accent", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ accent?: unknown }>) : null))
      .then((body) => {
        if (live && typeof body?.accent === "string") cacheAdminAccent(body.accent);
      })
      .catch(() => {
        // 讀不到就維持預設色;下次載入快取還是空的,會再試一次。
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ADMIN_ACCENT_STORAGE_KEY) paintAdminAccent(readCachedAccent());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return null;
}

/**
 * 掛在設定頁:拿到的是 DB 上的值(那頁本來就要載入全部設定)。跟快取不同就更新 ——
 * 存檔後 router.refresh 帶來新值、立刻生效;別台電腦改過色,這裡也會跟上。
 */
export function AdminAccentCacheSync({ accent }: { accent: unknown }) {
  useEffect(() => {
    const value = (typeof accent === "string" && normalizeHex(accent)) || DEFAULT_ADMIN_ACCENT;
    if (readCachedAccent() !== value) cacheAdminAccent(value);
  }, [accent]);
  return null;
}
