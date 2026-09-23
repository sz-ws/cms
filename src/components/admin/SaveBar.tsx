"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 設定頁底部浮動的儲存列:有變更才浮上來。核心設定與風格分頁共用,兩邊存檔的
// 位置與樣子一致。收起時整條 inert —— 只是透明的話,它還是會吃掉畫面底部的點擊。

export const SAVE_BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink pr-3 pl-3.5 text-[14px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-ink/85 active:scale-[0.96] focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.15)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45";

export const SAVE_BAR_SECONDARY_CLASS =
  "inline-flex h-10 items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 text-[13px] font-medium text-ink/55 transition-colors hover:bg-ink/[0.04] hover:text-ink/80 focus-visible:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] focus-visible:outline-none disabled:opacity-45";

export function SaveBar({
  visible,
  title,
  note,
  alert,
  children,
}: {
  visible: boolean;
  title: string;
  /** 標題下的一行小字;沒有要說的就不給。 */
  note?: string;
  /** 儲存失敗:讀屏立刻念,不等 polite。 */
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      inert={!visible}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 transition-[opacity,transform] duration-220 ease-out",
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
      )}
    >
      <div
        className={cn(
          "w-full max-w-4xl rounded-[calc(20px*var(--admin-radius-scale,1))] bg-surface/65 p-1.5 shadow-[var(--admin-shadow-panel,0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18))] backdrop-blur-md",
          visible && "pointer-events-auto",
        )}
      >
        <div className="flex items-center justify-between gap-4 rounded-[calc(14px*var(--admin-radius-scale,1))] bg-surface px-4 py-3 shadow-[var(--admin-shadow-card,0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04))]">
          <div role={alert ? "alert" : "status"} aria-live={alert ? "assertive" : "polite"} className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12px] font-medium text-ink/45">{title}</span>
            {note ? <span className="text-[11px] text-ink/35">{note}</span> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}
