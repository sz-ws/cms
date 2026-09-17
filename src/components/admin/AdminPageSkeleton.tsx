"use client";

import { useT } from "@/lib/i18n/I18nProvider";

// 換頁時佔住內容區的骨架(admin/loading.tsx 用它)。側欄與頂欄不動,只有內容
// 換成這一版 —— 點下去就有反應,而不是整個介面僵住幾百毫秒。
//
// 動效只有一道從左到右掃過的光,1.4 秒一輪:骨架要說的是「正在載入」,不是
// 「這裡有狀態在跳動」。不用呼吸式的明暗閃爍(admin 的設計紅線)。
//
// 形狀刻意畫得像後台最常見的那一頁:標題 + 說明 + 一張表。不假裝知道實際欄數,
// 六列就好 —— 再多會在資料回來時造成一次明顯的高度塌陷。
function Bar({ className }: { className: string }) {
  return <span className={`admin-skeleton block rounded-[6px] ${className}`} />;
}

export function AdminPageSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex max-w-6xl flex-col gap-6"
    >
      <span className="sr-only">{t("admin.loading")}</span>
      <div className="flex flex-col gap-2.5">
        <Bar className="h-[22px] w-40" />
        <Bar className="h-3.5 w-72 max-w-full" />
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <div className="flex items-center gap-4 border-b border-black/[0.06] px-4 py-3">
          <Bar className="h-3 w-24" />
          <Bar className="h-3 w-16" />
          <Bar className="ms-auto h-3 w-20" />
        </div>
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div
            key={row}
            className="flex items-center gap-4 border-b border-black/[0.04] px-4 py-3.5 last:border-b-0"
          >
            <Bar className="h-3.5 w-36" />
            <Bar className="h-3.5 w-20" />
            <Bar className="ms-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
