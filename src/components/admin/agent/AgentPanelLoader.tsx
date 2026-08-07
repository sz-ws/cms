"use client";

import dynamic from "next/dynamic";
import type { AgentToolSummary } from "./tools";

// docs/spec-admin-agent.md §5:面板的載入點。
//
// 存在的唯一理由是**打包隔離**:AgentPanel 這條相依鏈會拉進 motion 與整組對話
// 元件,而 spec §5 明定它不進全站 bundle(性能預算照舊)。next/dynamic 需要
// client component 才能用 ssr:false,所以 server 的 page.tsx 經這一層薄殼進來。
//
// ssr:false 也順帶解掉一件事:面板第一畫面沒有任何 server 能算出來的內容
// (transcript 一開始就是空的),SSR 它只是多送一份會被立刻丟掉的 HTML。

const AgentPanel = dynamic(
  () => import("./AgentPanel").then((m) => m.AgentPanel),
  {
    ssr: false,
    // 載入中的佔位:安靜的骨架,不是 kit spinner(admin-design-language.md)。
    loading: () => (
      <div
        aria-hidden
        className="h-[calc(100dvh-11rem)] min-h-[26rem] rounded-[14px] bg-black/[0.015]"
      />
    ),
  },
);

export function AgentPanelLoader({ tools }: { tools: AgentToolSummary[] }) {
  return <AgentPanel tools={tools} />;
}
