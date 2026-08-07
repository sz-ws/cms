"use client";

import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { StatusDot } from "@/components/admin/dashboard/StatusDot";
import type { AgentToolCallLog } from "@/ext/agent-loop";
import { toolLeaf, toolNamespace } from "./tools";

// docs/spec-admin-agent.md §5:GAIA UI 的 Tool Calls Section 在這裡的角色 ——
// 「agent 這一輪實際查了什麼」的摺疊顯示。
//
// 結構取自 GAIA(ui.heygaia.io/r/tool-calls-section.json,MIT):摺疊標頭 +
// 「用了 N 個工具」+ 逐筆展開。三處改寫:
//   · 圖示改 lucide(repo 的既定 icon library),不引入 hugeicons 這個新相依;
//   · 疊放旋轉的 icon 堆換成一個安靜的 caption 列 —— 這個後台的層次來自留白,
//     不來自裝飾密度(admin-design-language.md「Character (use with restraint)」);
//   · 高度動畫改成單純的條件渲染。height 是 layout-bound 屬性,規則明列不動它;
//     動的只有 chevron 的 transform。
//
// 預設收合是刻意的:read 工具的執行結果對 admin 是**佐證**,不是主線。要看的時候
// 一定看得到(失敗與截斷在收合狀態下就有標記),不看的時候不佔版面。

interface ToolCallsSectionProps {
  calls: readonly AgentToolCallLog[];
}

export function ToolCallsSection({ calls }: ToolCallsSectionProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (calls.length === 0) return null;

  const failed = calls.filter((c) => !c.ok).length;
  const truncated = calls.some((c) => c.truncated);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="group/tools flex w-fit items-center gap-1.5 rounded-[8px] py-1 pr-2 pl-1 text-[11.5px] text-black/40 transition-colors duration-150 hover:bg-black/[0.03] hover:text-black/70"
      >
        <Wrench className="size-3.5 shrink-0 text-black/25 transition-colors group-hover/tools:text-black/45" />
        <span className="tabular-nums">
          {calls.length === 1
            ? t("agent.toolCountOne")
            : t("agent.toolCount", { count: calls.length })}
        </span>
        {failed > 0 && (
          <span className="rounded-[5px] bg-red-50 px-1.5 py-px text-[10.5px] text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.15)]">
            {t("agent.toolFailed")}
          </span>
        )}
        {truncated && (
          <span className="rounded-[5px] bg-black/[0.045] px-1.5 py-px text-[10.5px] text-black/45">
            {t("agent.toolTruncated")}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-black/25 transition-transform duration-150 ease-out",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <ul className="flex flex-col gap-px rounded-[12px] bg-white p-1.5 shadow-[0_0_0_1px_rgba(20,18,22,0.05),0_1px_2px_-1px_rgba(20,18,22,0.05)]">
          {calls.map((call, index) => (
            <li
              key={`${call.toolName}-${index}`}
              className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5"
            >
              <StatusDot tone={call.ok ? "good" : "draft"} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] lowercase">
                <span className="text-black/35">{toolNamespace(call.toolName)}.</span>
                <span className="text-black/75">{toolLeaf(call.toolName)}</span>
              </span>
              {call.truncated && (
                <span className="shrink-0 text-[10.5px] text-black/35">
                  {t("agent.toolTruncated")}
                </span>
              )}
              {!call.ok && (
                <span className="max-w-[14rem] shrink-0 truncate text-[10.5px] text-red-700/80">
                  {call.error ?? t("agent.toolFailed")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
