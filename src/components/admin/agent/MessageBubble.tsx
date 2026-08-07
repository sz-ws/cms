"use client";

import { Streamdown } from "streamdown";
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
//
// ── 1.32.0:助理訊息走 markdown(streamdown)────────────────────────────────
// 模型本來就在寫 markdown(清單、粗體、表格、程式碼),用 whitespace-pre-wrap
// 渲染等於把 `**` 與 `|---|` 直接印在後台。改用 streamdown(Vercel,Apache-2.0)
// 而不是 react-markdown 的理由只有一個:它是為**不完整的 markdown** 設計的 ——
// 串流到一半的 `**粗體` 或沒收尾的表格不會忽明忽暗地重排。
//
// 三個刻意不開的選項:
//   · `animated` / `caret` —— 逐字淡入與打字游標都是明列的紅線(閃爍/呼吸)。
//     文字在長本身就是進度訊號。
//   · `controls` —— 程式碼與表格右上角的 copy/download/fullscreen 按鈕。這是後台
//     對話,不是文件檢視器;那組浮動控制項會把「安靜的紙」變成工具列。
//   · 各種 plugin(code/mermaid/math/cjk)—— 一個都不裝。它們會把 shiki、mermaid
//     這種等級的相依拉進來,而面板的收益是「清單與粗體能看」,不是語法高亮。
//
// 樣式:streamdown 的預設 class 走 shadcn token(bg-muted / border-border /
// text-primary…),那些 token 在 globals.css 已被 remap 成 Paper & Ink,所以顏色
// 自動對;字級與間距則由 globals.css 的 `.agent-markdown` 區塊收斂到面板的尺度
// (預設的 text-3xl 標題與 my-4 在 14px 的對話裡太大)。
//
// 使用者訊息維持純文字:那是**使用者自己打的字**,把它當 markdown 解析等於讓
// 「用 * 標重點」這種輸入被系統重寫成別的樣子。

interface MessageBubbleProps {
  variant: "user" | "assistant";
  /** 說話者標籤(11.5px 小字);助理的每一段都標,使用者的不標(對齊已經說明了)。 */
  label?: string;
  /** 訊息內文。assistant 走 markdown,user 原樣顯示。 */
  children: string;
  /** 助理訊息還在串流中(未定稿)。只影響 streamdown 的補完策略,不影響外觀。 */
  streaming?: boolean;
  className?: string;
}

export function MessageBubble({
  variant,
  label,
  children,
  streaming = false,
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
      {label && <span className="text-[11px] text-black/30">{label}</span>}
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        controls={false}
        className="agent-markdown max-w-[46rem] text-[14px] leading-[1.7] text-black/85"
      >
        {children}
      </Streamdown>
    </div>
  );
}
