"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";

// 2.0:設定頁的「網站頁面」區塊(同 ContentExportCard 的切片:border-t 分隔 + 標題列 + 內容)。
// 網站的每一頁先存好、訪客打開時直接送出;內容、設定、插件一變就自動重新產生。這個按鈕給「網站上還是
// 舊的」的時候用(例如有人直接改了資料庫),呼叫 /api/public-pages/refresh。文案寫給店家看:不出現
// 快取、伺服器之類的字。

type State = "idle" | "busy" | "done" | "failed";

export function PublicPagesRefreshCard() {
  const t = useT();
  const [state, setState] = useState<State>("idle");

  async function refresh() {
    setState("busy");
    try {
      const res = await fetch("/api/public-pages/refresh", { method: "POST" });
      setState(res.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-ink/[0.06] pt-6">
      <div>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">{t("publicPages.title")}</h3>
        <p className="text-[12px] leading-relaxed text-ink/40">{t("publicPages.desc")}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p role="status" aria-live="polite" className="text-[12.5px] text-ink/55 sm:mr-auto">
          {state === "done" ? t("publicPages.done") : state === "failed" ? t("publicPages.failed") : null}
        </p>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={state === "busy"} className="gap-1.5">
          <RefreshCw className="size-4" />
          {t("publicPages.refresh")}
        </Button>
      </div>
    </div>
  );
}
