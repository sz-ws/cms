"use client";

import { cn } from "@/lib/utils";

// docs/spec-admin-agent.md §5:GAIA UI 的 Message Bubble 在這個系統裡的樣子。
//
// 結構取自 GAIA(ui.heygaia.io/r/message-bubble.json,MIT),視覺層整份重寫:
// 原件是 iMessage 仿作(#00bbff 泡泡、zinc-300 對話方、尾巴 pseudo-element、
// dark-mode-first),與 docs/admin-design-language.md 的「Paper & Ink」相衝,
// 而該文件把「dark-mode-first anything」「gray-on-white 加一個裝飾色」列為即刻退件。
//
// 這裡的取捨:**只有使用者的話是泡泡**。使用者說的話是浮在紙上的白卡(白 on 紙
// 就是這個系統製造層次的方式),助理的回答直接印在紙上 —— 沒有框、沒有底色,
// 就是版面上的正文。層次因此來自「誰的話浮起來」,不是來自兩個互相對立的色塊。

interface MessageBubbleProps {
  variant: "user" | "assistant";
  /** 說話者標籤(11.5px 小字);助理的每一段都標,使用者的不標(對齊已經說明了)。 */
  label?: string;
  children: React.ReactNode;
  className?: string;
}

export function MessageBubble({
  variant,
  label,
  children,
  className,
}: MessageBubbleProps) {
  if (variant === "user") {
    return (
      <div className={cn("flex justify-end", className)}>
        <div className="max-w-[85%] rounded-[14px] bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-black/85 shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08)]">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <span className="text-[11px] text-black/30">{label}</span>
      )}
      <div className="max-w-[46rem] text-[14px] leading-[1.7] whitespace-pre-wrap text-black/85">
        {children}
      </div>
    </div>
  );
}
