"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { RingDot } from "@/components/admin/dashboard/RingDot";
import type { AgentChatOutcome } from "@/ext/agent-loop";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { ProposalCard } from "./ProposalCard";
import { ToolCallsSection } from "./ToolCallsSection";
import type { AgentToolSummary } from "./tools";
import {
  appendUserMessage,
  applyChatOutcome,
  applyProposalResolution,
  canSend,
  emptyTranscript,
} from "./transcript";
import type { ProposalDecision, TranscriptState } from "./transcript";

// docs/spec-admin-agent.md §5:/admin/agent 對話面板的本體。
//
// 這個元件只做三件事:接線 /chat 與 /execute、把 transcript.ts 的純函式串起來、
// 渲染。**所有關於「對話應該長什麼樣」的規則都不在這裡** —— 尤其是「確認與取消
// 兩條路都要補 tool_result」那一條,它住在 transcript.ts 並且有測試釘住。這裡若
// 自己拼一則訊息,那條規則就多了一個沒被測到的實作。
//
// server 是 stateless(spec §4):transcript 由本元件持有,每次 /chat 送完整份。
// 對應地,「開新對話」就只是把 state 換成 emptyTranscript() —— 沒有要清的 session。
//
// 提案處置之後會**自動再打一次 /chat**:tool_result 接回去了,模型還沒看過它。
// 少了這一步,admin 按下確認之後會看到一個結果卡然後沒有下文。

/** AI 設定所在的 admin 設定頁錨點(SettingsWorkspace 的 sectionAnchorId 慣例)。 */
const AI_SETTINGS_HREF = "/admin/settings#section-core-ai";

interface AgentPanelProps {
  /** server component 在 server 端從 buildAgentToolRegistry() 取出後傳下來。 */
  tools: AgentToolSummary[];
}

/** 傳輸層(而非 loop 層)的失敗。loop 的失敗走 transcript 的 notice entry。 */
type TransportError = "rate_limited" | "network" | "forbidden" | "unknown";

export function AgentPanel({ tools }: AgentPanelProps) {
  const t = useT();
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [transport, setTransport] = useState<TransportError | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新內容進來就捲到底。條目數當相依 —— 內容本身是不可變的,新增才需要捲動。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [state.entries.length, busy]);

  /** 送出目前的 transcript,把回應接上去。永不 throw。 */
  async function runChat(next: TranscriptState): Promise<void> {
    setState(next);
    setBusy(true);
    setTransport(null);
    try {
      const res = await fetch("/api/admin/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.messages }),
      });
      if (!res.ok) {
        setTransport(
          res.status === 429
            ? "rate_limited"
            : res.status === 401 || res.status === 403
              ? "forbidden"
              : "unknown",
        );
        return;
      }
      const outcome = (await res.json()) as AgentChatOutcome;
      setState((prev) => applyChatOutcome(prev, outcome));
    } catch {
      setTransport("network");
    } finally {
      setBusy(false);
    }
  }

  function onSend(text: string): void {
    if (busy || !canSend(state)) return;
    void runChat(appendUserMessage(state, text));
  }

  /** 確認卡的唯一執行入口(spec §4:真相只有一個入口 —— /execute)。 */
  async function onConfirm(): Promise<void> {
    const pending = state.pending;
    if (!pending || executing || busy) return;
    setExecuting(true);
    let decision: ProposalDecision;
    try {
      const res = await fetch("/api/admin/agent/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: pending.toolName, args: pending.args }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: unknown; error?: string }
        | null;
      decision =
        body && body.ok === true
          ? { kind: "confirmed", ok: true, result: body.result }
          : {
              kind: "confirmed",
              ok: false,
              error: body?.error ?? `http_${res.status}`,
            };
    } catch {
      // 連不上:這個動作**可能已經執行也可能沒有**,前端無從得知。仍然補一則
      // tool_result(否則 transcript 帶著懸空的 tool_use,下一句話就送不出去),
      // 並如實把不確定寫進去 —— 讓模型與 admin 都看得到要去核對,而不是假設失敗。
      decision = { kind: "confirmed", ok: false, error: "network_error_outcome_unknown" };
    }
    setExecuting(false);
    await runChat(applyProposalResolution(state, decision));
  }

  function onCancel(): void {
    if (!state.pending || executing || busy) return;
    // 取消也要把結果接回去(見 transcript.ts 檔頭),然後讓模型知道它被否決了。
    void runChat(applyProposalResolution(state, { kind: "cancelled" }));
  }

  function onNewChat(): void {
    if (busy || executing) return;
    setState(emptyTranscript());
    setTransport(null);
  }

  const locked = state.pending !== null;
  const hasContent = state.entries.length > 0;

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[26rem] flex-col gap-3">
      {/* 對話區不包卡:訊息直接坐在紙上,浮起來的是使用者的話與確認卡。
          role="log" + aria-live:新回覆對讀螢幕的人也要被念出來,而不是只有捲動。 */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy || executing}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-5 pb-4">
          {!hasContent && <EmptyState />}

          {state.entries.map((entry) => {
            switch (entry.kind) {
              case "user":
                return (
                  <MessageBubble key={entry.id} variant="user">
                    {entry.text}
                  </MessageBubble>
                );
              case "assistant":
                return (
                  <MessageBubble
                    key={entry.id}
                    variant="assistant"
                    label={t("agent.assistant")}
                  >
                    {entry.text}
                  </MessageBubble>
                );
              case "toolCalls":
                return <ToolCallsSection key={entry.id} calls={entry.calls} />;
              case "proposal":
                return (
                  <ProposalCard
                    key={entry.id}
                    proposal={entry.proposal}
                    resolution={entry.resolution}
                    outcome={entry.outcome}
                    running={executing && entry.resolution === "pending"}
                    onConfirm={() => void onConfirm()}
                    onCancel={onCancel}
                  />
                );
              case "notice":
                return <Notice key={entry.id} tone={entry.tone} detail={entry.detail} />;
            }
          })}

          {transport && <TransportNotice code={transport} />}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[46rem]">
        <Composer
          tools={tools}
          disabled={locked || busy || executing}
          busy={busy}
          lockedNote={locked ? t("agent.lockedByProposal") : null}
          onSend={onSend}
        />
        {hasContent && (
          <button
            type="button"
            onClick={onNewChat}
            disabled={busy || executing}
            className="mt-2 inline-flex items-center gap-1.5 rounded-[8px] px-1 py-1 text-[11.5px] text-black/35 transition-colors duration-150 hover:text-black/70 disabled:opacity-40"
          >
            <RotateCcw className="size-3" />
            {t("agent.newChat")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 空狀態:一個安靜的 ring-dot 標記 + 一句話(admin-design-language.md)。 */
function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-2 pt-6">
      <RingDot accent />
      <p className="text-[17px] font-semibold tracking-[-0.01em] text-black/90">
        {t("agent.emptyTitle")}
      </p>
      <p className="max-w-[32rem] text-[13px] leading-relaxed text-black/40">
        {t("agent.emptyBody")}
      </p>
    </div>
  );
}

/** loop 層的告知:步數上限、或上游錯誤。錯誤碼決定文案,不是一句通用錯誤(spec §4.5)。 */
function Notice({ tone, detail }: { tone: "maxSteps" | "error"; detail?: string }) {
  const t = useT();

  if (tone === "maxSteps") {
    return (
      <p className="rounded-[10px] bg-black/[0.03] px-3 py-2 text-[12.5px] text-black/50">
        {t("agent.maxSteps")}
      </p>
    );
  }

  const notConfigured = detail === "not_configured";
  const body =
    detail === "tool_use_not_supported"
      ? t("agent.error.toolUseNotSupported")
      : notConfigured
        ? t("agent.error.notConfigured")
        : detail === "timeout"
          ? t("agent.error.timeout")
          : t("agent.error.generic", { detail: detail ?? "" });

  return (
    <div
      className={cn(
        "flex max-w-[36rem] flex-col gap-2 rounded-[10px] bg-red-50 px-3 py-2.5",
        "shadow-[0_0_0_1px_rgba(220,38,38,0.15)]",
      )}
    >
      <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-red-700">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        {body}
      </p>
      {notConfigured && (
        <Link
          href={AI_SETTINGS_HREF}
          className="w-fit rounded-[8px] bg-white px-2.5 py-1 text-[12px] font-medium text-black/75 shadow-[0_0_0_1px_rgba(20,18,22,0.07)] transition-colors duration-150 hover:text-black"
        >
          {t("agent.error.notConfiguredCta")}
        </Link>
      )}
    </div>
  );
}

/** 傳輸層失敗(HTTP 沒有成功接受這個請求)。不進 transcript —— 什麼都沒發生。 */
function TransportNotice({ code }: { code: TransportError }) {
  const t = useT();
  const body =
    code === "rate_limited"
      ? t("agent.error.rateLimited")
      : code === "network"
        ? t("agent.error.network")
        : t("agent.error.generic", { detail: code });
  return (
    <p className="flex max-w-[36rem] items-start gap-2 rounded-[10px] bg-red-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.15)]">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      {body}
    </p>
  );
}
