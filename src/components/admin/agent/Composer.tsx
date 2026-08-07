"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useImeGuard } from "@/lib/ime";
import { useT } from "@/lib/i18n/I18nProvider";
import { DotmSquare5 } from "@/components/ui/dotm-square-5";
import { SlashCommandDropdown } from "./SlashCommandDropdown";
import type { AgentToolSummary } from "./tools";
import { applySlashSelection, matchTools, readSlashQuery } from "./tools";

// docs/spec-admin-agent.md §5:GAIA UI 的 Composer 在這裡的角色。
//
// 結構取自 GAIA(ui.heygaia.io/r/composer.json,MIT):自動長高的 textarea、
// Enter 送出 / Shift+Enter 換行、`/` 觸發工具選單、送出鍵在右下角。改寫三處:
//   · 去掉附件/檔案預覽那一整條(這個面板不吃檔案,留著只是死路);
//   · 送出中的指示器用 repo 自己的 dot-matrix loader(DotmSquare5)。GAIA 的
//     Wave Spinner 沒有抄:它的 keyframes 是 opacity 0.3↔1 + scale 0.8↔1 的
//     脈動點,正是 CLAUDE.md 明列的紅線;而這個 repo 早就有一個屬於自己的
//     載入標記(SearchPalette 用的同一個),沿用它同時解掉紅線與「不要造第二套」;
//   · 配色 Paper & Ink。
//
// **工具清單由 server component 傳進來**(page.tsx → AgentPanel → 這裡),不打
// API —— 清單只在「換頁」的尺度上變動,為它開一支端點只是多一個要防的表面。

interface ComposerProps {
  tools: readonly AgentToolSummary[];
  /** 有待確認的提案 / 已在送出中 → 不能再送。 */
  disabled: boolean;
  /** /chat 進行中(顯示 loader)。 */
  busy: boolean;
  /** 被提案鎖住時顯示的說明;null = 沒被鎖。 */
  lockedNote: string | null;
  onSend: (text: string) => void;
}

/** textarea 高度上限(px)。超過就內部捲動,不把 composer 撐到吃掉整個對話區。 */
const MAX_TEXTAREA_PX = 200;

export function Composer({
  tools,
  disabled,
  busy,
  lockedNote,
  onSend,
}: ComposerProps) {
  const t = useT();
  const ime = useImeGuard();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  // Esc 關掉選單之後,要等下一次重新打出 `/` 才再開 —— 否則 Esc 等於沒有作用。
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [selected, setSelected] = useState(0);

  const slash = slashDismissed ? null : readSlashQuery(text, caret);
  const matches = slash ? matchTools(tools, slash.query) : [];
  const activeIndex = matches.length === 0 ? -1 : Math.min(selected, matches.length - 1);

  // 自動長高。在 effect 裡改 DOM 樣式(而不是 render 時算)是刻意的:高度取決於
  // 換行後的實際排版,只有瀏覽器知道。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  function syncCaret(el: HTMLTextAreaElement): void {
    setCaret(el.selectionStart ?? el.value.length);
  }

  function pick(tool: AgentToolSummary): void {
    if (!slash) return;
    const next = applySlashSelection(text, slash, caret, tool.name);
    setText(next.text);
    setCaret(next.caret);
    setSelected(0);
    // React 提交之後才動得了 selection(此刻 DOM 裡還是舊的 value)。
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  function submit(): void {
    const value = text.trim();
    if (value.length === 0 || disabled) return;
    setText("");
    setCaret(0);
    setSlashDismissed(false);
    onSend(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // **第一行,先於所有其他判斷。** 打注音的人按 Enter 是在確定候選字,不是要送出;
    // 而選字時的 ↑↓ 是在翻候選清單,不是在翻 slash 選單。組字期間整個元件讓開。
    if (ime.isComposingKey(e)) return;
    if (slash) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (matches.length === 0) return;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSelected((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && activeIndex >= 0) {
        e.preventDefault();
        pick(matches[activeIndex]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const canSubmit = text.trim().length > 0 && !disabled;

  return (
    <div className="relative flex flex-col gap-1.5">
      {slash && (
        <SlashCommandDropdown
          matches={matches}
          selectedIndex={activeIndex}
          onSelect={pick}
          onHover={setSelected}
        />
      )}

      <div
        className={cn(
          // 同心圓角:控制項 8px 在 14px 的殼裡(內距 6px)。
          "flex items-end gap-2 rounded-[14px] bg-white p-1.5 pl-3",
          "shadow-[0_0_0_1px_rgba(20,18,22,0.06),0_1px_2px_-1px_rgba(20,18,22,0.06),0_3px_10px_-4px_rgba(30,20,50,0.08)]",
          "transition-shadow duration-150 ease-out",
          "focus-within:shadow-[0_0_0_1px_rgba(20,18,22,0.10),0_0_0_3px_rgba(86,114,228,0.08),0_3px_10px_-4px_rgba(30,20,50,0.10)]",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={t("agent.placeholder")}
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
            setSlashDismissed(false);
          }}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
          onKeyDown={onKeyDown}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          className="min-h-9 flex-1 resize-none self-center bg-transparent py-2 text-[14px] leading-relaxed text-black/85 outline-none placeholder:text-black/25"
        />

        {/* 送出中:dot-matrix loader(靜態 spinner 的角色;reduced-motion 由元件處理)。 */}
        {busy && (
          <DotmSquare5
            size={18}
            dotSize={2.5}
            color="rgba(0,0,0,0.40)"
            ariaLabel={t("agent.stopHint")}
            className="mb-2 shrink-0"
          />
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          aria-label={t("agent.send")}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[8px]",
            "transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.94]",
            canSubmit
              ? "bg-black text-white hover:bg-black/85"
              : "bg-black/[0.06] text-black/25",
          )}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>

      <p className="px-1 text-[11px] text-black/30">
        {lockedNote ?? t("agent.toolsAvailable", { count: tools.length })}
      </p>
    </div>
  );
}
