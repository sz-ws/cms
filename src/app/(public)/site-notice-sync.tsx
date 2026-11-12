"use client";

import { useEffect } from "react";
import { noticeShownAt, type SiteNoticeWindow } from "@/lib/site-notice";

// 2.0:有時段的公告,第一次載入時由頁面裡的 inline script 決定出不出現(site-notice.tsx)。
// 從站內別的頁面點過來(client 端換頁)時 inline script 不會執行,這裡在掛上之後補做同一個判斷。
export function SiteNoticeSync({ id, startsAt, endsAt }: { id: string } & Pick<SiteNoticeWindow, "startsAt" | "endsAt">) {
  useEffect(() => {
    const bar = document.getElementById(id);
    if (bar) bar.hidden = !noticeShownAt({ text: "", startsAt, endsAt }, Date.now());
  }, [id, startsAt, endsAt]);
  return null;
}
