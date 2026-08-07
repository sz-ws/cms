"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import type { AgentToolSummary } from "./tools";
import { toolBlurb, toolLeaf, toolNamespace } from "./tools";

// docs/spec-admin-agent.md §5:GAIA UI 的 Slash Command Dropdown 在這裡的角色 ——
// 打 `/` 直接點名一個 tool。
//
// 結構取自 GAIA(ui.heygaia.io/r/slash-command-dropdown.json,MIT):受控的
// matches + selectedIndex + onSelect、選中項自動捲進視野、空結果有自己的文案。
// 三處改寫:
//   · 去掉 hugeicons 的分類圖示矩陣 —— 這個 registry 的 tool 名本身就是分類
//     (`content.gallery_item.list`),把命名空間排版出來比配十幾個猜出來的圖示誠實;
//   · fixed + 手算座標改成 absolute + 相對 composer 定位(面板是版面內的元件,
//     不是全螢幕 overlay,手算座標在側欄收合/視窗縮放時會錯位);
//   · 配色改 Paper & Ink(白面板浮在紙上、ink-with-opacity 文字),不用 zinc + dark。
//
// **write tool 在清單上標「需確認」**:選單是使用者第一次看見這個 tool 的地方,
// 確認制應該在那時候就說清楚,而不是等提案卡跳出來才第一次提。

interface SlashCommandDropdownProps {
  matches: readonly AgentToolSummary[];
  selectedIndex: number;
  onSelect: (tool: AgentToolSummary) => void;
  onHover: (index: number) => void;
}

export function SlashCommandDropdown({
  matches,
  selectedIndex,
  onSelect,
  onHover,
}: SlashCommandDropdownProps) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // 鍵盤移動時把選中項捲進視野(GAIA 原件的行為;沒有它,↓ 到第七項就看不見了)。
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      role="listbox"
      aria-label={t("agent.slash.title")}
      // 同心圓角:列 8px → 面板 14px(內距 6px)。
      className="absolute bottom-full left-0 z-30 mb-2 w-[min(28rem,100%)] overflow-hidden rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_16px_48px_-12px_rgba(30,20,50,0.18)]"
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto">
        {matches.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-black/35">
            {t("agent.slash.empty")}
          </p>
        ) : (
          matches.map((tool, index) => (
            <button
              key={tool.name}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-index={index}
              onMouseMove={() => onHover(index)}
              // onMouseDown + preventDefault:textarea 不能在點擊時失焦,否則
              // 插入之後游標位置就丟了(onClick 太晚,blur 已經發生)。
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(tool);
              }}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-150",
                index === selectedIndex ? "bg-black/[0.045]" : "hover:bg-black/[0.025]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11.5px] lowercase">
                  <span className="text-black/35">{toolNamespace(tool.name)}.</span>
                  <span className="font-medium text-black/85">{toolLeaf(tool.name)}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-black/40">
                  {toolBlurb(tool.description)}
                </span>
              </span>
              <span
                className={cn(
                  "mt-px shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px]",
                  tool.kind === "write"
                    ? "bg-[rgba(86,114,228,0.10)] text-[rgb(63,88,192)]"
                    : "bg-black/[0.04] text-black/40",
                )}
              >
                {tool.kind === "write"
                  ? t("agent.slash.needsConfirm")
                  : t("agent.slash.readOnly")}
              </span>
            </button>
          ))
        )}
      </div>
      <p className="px-2.5 pt-1.5 pb-0.5 text-[10.5px] text-black/30">
        {t("agent.slash.hint")}
      </p>
    </div>
  );
}
