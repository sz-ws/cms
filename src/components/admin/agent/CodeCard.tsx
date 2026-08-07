"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { RingDot } from "@/components/admin/dashboard/RingDot";
import type { AgentCode, AgentCodeOutput } from "@/ext/agent-loop";
import type { CodeResolution } from "./transcript";

// docs/spec-admin-agent.md §4.7:JS 沙盒卡。
//
// 確認卡問「這件事要不要做」,反問卡問「做之前少了什麼」,這張卡不問任何事 ——
// 它**報告**。沒有副作用的東西不需要一張確認卡:那段程式碼碰不到站上的資料、沒有
// 網路、跑在一個空的直譯器裡(code-sandbox.worker.ts 的檔頭是完整理由)。
//
// 但它必須**看得見**,而那正是這張卡存在的唯一理由:admin 要能看到模型到底跑了
// 什麼。所以程式碼原文原樣攤在卡上,不摺疊、不摘要 —— 一段被藏起來的程式碼與一段
// 被執行的程式碼之間的差別,是這個功能能不能被信任的全部。
//
// 「不要執行」是一條**出口**而不是一道關卡:預設會跑,admin 覺得不對可以按掉。
// 按掉照樣補一則 tool_result(「admin 沒有執行」),不是錯誤 —— 見 transcript.ts。
//
// 視覺完全沿 ProposalCard / AskCard 的語彙(同心圓角 20 → 14 → 8、shadow 造層次、
// 靜態 RingDot、右對齊動作列),差別只在中間那一塊是 <pre>。
//
// 動效紅線(CLAUDE.md):**沒有任何 pulsing / ping / 呼吸光暈 / 閃爍游標**。
// 「執行中」是一顆**靜態**的 RingDot 加一行字 —— 它只會停留幾百毫秒到幾秒,而一個
// 會跳的點在那幾秒裡唯一的作用是讓人焦慮。進場只有一次 opacity + y 位移,
// prefers-reduced-motion 時直接關掉。

interface CodeCardProps {
  code: AgentCode;
  resolution: CodeResolution;
  /** resolution:"ran" 時沙盒回報了什麼。 */
  output?: AgentCodeOutput;
  onDecline: () => void;
}

/** 動作列按鈕:同 ProposalCard 的次動作(白底 + shadow 造框)。 */
const DECLINE_CLASSES = cn(
  "inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3.5 text-[13px] font-medium",
  "bg-white text-black/65 shadow-[0_0_0_1px_rgba(20,18,22,0.07),0_1px_2px_-1px_rgba(20,18,22,0.06)]",
  "transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out",
  "hover:text-black/90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45",
);

/** 等寬區塊:程式碼、結果、輸出三處共用,所以三者的尺度不會各走各的。 */
function MonoBlock({ children, tone = "ink" }: { children: string; tone?: "ink" | "error" }) {
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto rounded-[8px] px-2.5 py-2",
        "font-mono text-[11px] leading-[1.65] whitespace-pre-wrap break-words",
        tone === "error"
          ? "bg-red-50 text-red-800"
          : "bg-black/[0.035] text-black/70",
      )}
    >
      {children}
    </pre>
  );
}

/** 一段有標題的區塊。標題用 11.5px 的弱化字,同確認卡的「參數」那一列。 */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11.5px] font-medium text-black/45">{label}</p>
      {children}
    </div>
  );
}

/**
 * 結果的顯示文字。
 *
 * 物件與陣列縮排排版(admin 是要讀它的),純量直接印。序列化失敗時退回
 * String() —— 卡片上少一個漂亮的排版,好過整張卡因為一個值而畫不出來。
 */
function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 跑完之後的那幾段:結果 / 輸出 / 錯誤。 */
function Outcome({ output }: { output?: AgentCodeOutput }) {
  const t = useT();
  if (!output) return null;

  const hasResult = output.result !== undefined;
  return (
    <div className="flex flex-col gap-3">
      {output.error && (
        <Section label={t("agent.code.errorLabel")}>
          <MonoBlock tone="error">{output.error}</MonoBlock>
        </Section>
      )}

      {hasResult && (
        <Section label={t("agent.code.resultLabel")}>
          <MonoBlock>{formatResult(output.result)}</MonoBlock>
        </Section>
      )}

      {output.note && (
        <p className="text-[11.5px] leading-relaxed text-black/40">{output.note}</p>
      )}

      {!hasResult && !output.error && !output.note && (
        <p className="text-[12px] text-black/35">{t("agent.code.noResult")}</p>
      )}

      {output.logs && output.logs.length > 0 && (
        <Section label={t("agent.code.logsLabel")}>
          <MonoBlock>{output.logs.join("\n")}</MonoBlock>
        </Section>
      )}
    </div>
  );
}

export function CodeCard({ code, resolution, output, onDecline }: CodeCardProps) {
  const t = useT();
  const reduced = useReducedMotion();

  const pending = resolution === "pending";
  const ok = resolution === "ran" && output?.ok === true;
  const heading = pending
    ? t("agent.code.running")
    : resolution === "declined"
      ? t("agent.code.declined")
      : ok
        ? t("agent.code.done")
        : t("agent.code.failed");

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "w-full max-w-[36rem] rounded-[20px] p-1.5 backdrop-blur-md",
        pending
          ? "bg-white/55 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_-12px_rgba(30,20,50,0.18)]"
          : "bg-transparent",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3.5 rounded-[14px] bg-white p-4",
          "shadow-[0_0_0_1px_rgba(20,18,22,0.055),0_1px_2px_-1px_rgba(20,18,22,0.06)]",
          !pending && "opacity-90",
        )}
      >
        <div className="flex items-center gap-2">
          {/* 靜態 ring-dot。執行中不閃、不跳、不呼吸 —— 見檔頭的動效紅線。 */}
          <RingDot accent={pending} />
          <span
            className={cn(
              "text-[11.5px]",
              resolution === "ran" && !ok ? "text-red-700" : "text-black/40",
            )}
          >
            {heading}
          </span>
          {resolution === "ran" &&
            (ok ? (
              <Check className="size-3.5 text-black/45" />
            ) : (
              <X className="size-3.5 text-red-700" />
            ))}
        </div>

        {/* 模型自己寫的一句話。沒給就不佔一行 —— 程式碼本身才是這張卡的主體。 */}
        {code.reason && (
          <p className="text-[14px] leading-relaxed text-black/85">{code.reason}</p>
        )}

        <Section label={t("agent.code.codeLabel")}>
          <MonoBlock>{code.code}</MonoBlock>
        </Section>

        {pending ? (
          <>
            <p className="text-[11.5px] leading-relaxed text-black/35">
              {t("agent.code.note")}
            </p>
            {/* 表單動作靠右(admin-design-language.md「Controls」)。這裡只有一顆:
                「執行」不需要按鈕 —— 它已經在跑了。 */}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onDecline} className={DECLINE_CLASSES}>
                {t("agent.code.decline")}
              </button>
            </div>
          </>
        ) : resolution === "declined" ? (
          <p className="text-[12px] text-black/40">{t("agent.code.declinedNote")}</p>
        ) : (
          <Outcome output={output} />
        )}
      </div>
    </motion.div>
  );
}
