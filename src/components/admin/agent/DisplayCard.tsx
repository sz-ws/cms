"use client";

import { DashboardWidget } from "@/components/admin/dashboard/widgets";
import type { AgentDisplay } from "@/ext/agent-display";

// docs/spec-admin-agent.md §5.1:read tool 結果的卡片式呈現。
//
// 這個元件**不畫任何圖**。它只做一件事:把 tool 宣告的 { kind, preset, data } 交給
// dashboard 既有的 preset 查找表(widgets/index.tsx 的 DashboardWidget)。所以:
//
//   · 助理回答裡的長條圖與 /admin 首頁的長條圖是同一個元件,不是「很像」;
//   · 之後 widget 家族改配色 / 改圓角,這裡不必跟著改一次;
//   · 這裡沒有任何地方可以偷偷加一個只有 agent 面板才有的圖表變體。
//
// 代價說清楚:引整張查找表等於把八款 preset(含 donut 用的 recharts)一起帶進面板
// 的 dynamic chunk,即使 core 的三個統計 tool 只用到其中三款。這是刻意付的 ——
// **extension 宣告的 display 可以挑任何一款**,只引「core 現在用得到的那幾個」等於
// 讓第三方 tool 的卡片在正式站上安靜地畫不出來。面板本來就走 next/dynamic
// (AgentPanelLoader),不進全站 bundle;recharts 也已經在 admin dashboard 那條鏈上。
//
// kind → data 的型別在 AgentDisplay 就綁死了(佔比家族吃 ProportionWidgetData、
// 趨勢家族吃 TrendWidgetData),所以下面這個 switch 是**收斂**而不是斷言:
// DashboardWidget 的 props 是判別式聯集,傳錯家族在編譯期就會被擋下。
//
// 動效紅線(CLAUDE.md,不可協商):**沒有 pulsing / ping / 呼吸光暈 / 閃爍**。
// 卡片是靜態的 —— 它承載的是數字,而會動的數字看起來永遠像還沒算完。widget 內部
// 既有的一次性 transition(長條寬度、環的 dash offset)保留:那是資料變化時的
// 對位,不是閒置時的裝飾。

export function DisplayCard({ display }: { display: AgentDisplay }) {
  return (
    // max-w 對齊面板那一欄(AgentPanel 的 max-w-[46rem])但再窄一階:卡片是答案的
    // 佐證,不該比助理說的那段話還寬。
    <div className="w-full max-w-[36rem]">
      {/* 兩個分支的 JSX 逐字相同,但型別不同,而且必須分開寫:DashboardWidget 的
          props 是判別式聯集(佔比 preset 只收 ProportionWidgetData、趨勢 preset 只
          收 TrendWidgetData),AgentDisplay 的 `kind` 正是那個判別式。合併成一行就
          要 `as`,而 `as` 在這裡等於放棄「傳錯家族會編譯失敗」這個保證 —— 那正是
          兩個資料契約存在的全部意義。 */}
      {display.kind === "proportion" ? (
        <DashboardWidget preset={display.preset} data={display.data} />
      ) : (
        <DashboardWidget preset={display.preset} data={display.data} />
      )}
    </div>
  );
}

/**
 * 這一輪所有帶 display 的工具呼叫 → 一疊卡片。
 *
 * 一輪可以跑好幾個 tool(loop 的 runReadRound),所以卡片可能不只一張;沒有任何
 * 一個帶 display 時整段不渲染(回 null),不留空容器。
 */
export function DisplayCards({
  displays,
}: {
  displays: readonly AgentDisplay[];
}) {
  if (displays.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {displays.map((display, index) => (
        <DisplayCard key={`${display.kind}-${display.preset}-${index}`} display={display} />
      ))}
    </div>
  );
}
