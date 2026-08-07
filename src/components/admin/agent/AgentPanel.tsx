"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { RingDot } from "@/components/admin/dashboard/RingDot";
import type { AgentChatOutcome, AgentLoopEvent } from "@/ext/agent-loop";
import { AskCard } from "./AskCard";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { ProposalCard } from "./ProposalCard";
import { ToolCallsSection } from "./ToolCallsSection";
import type { AgentToolSummary } from "./tools";
import {
  appendUserMessage,
  applyAskResolution,
  applyChatOutcome,
  applyProposalResolution,
  canSend,
  emptyTranscript,
} from "./transcript";
import type {
  AskAnswer,
  AskDecision,
  ProposalDecision,
  TranscriptState,
} from "./transcript";
import { applyLoopEvent, emptyStreaming, splitSseFrames } from "./stream";
import type { StreamingState } from "./stream";

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
// 少了這一步,admin 按下確認之後會看到一個結果卡然後沒有下文。反問卡(§4.6)的
// 回答與關閉走同一條路 —— 它只是換一種 tool_result 內容。
//
// ── 1.32.0:串流 ────────────────────────────────────────────────────────────
// 送出改帶 `Accept: text/event-stream`,回應逐事件到達(SSE 的切割與顯示狀態都是
// ./stream.ts 的純函式)。**但 transcript 的來源沒有變**:串流出來的字只進
// `streaming` 這個暫態 state,transcript 一律等最後那個 outcome 事件、走
// applyChatOutcome 組裝 —— 收到 outcome 的當下就把暫態整段丟掉換成正式條目。
//
// 降級是自然的:回應的 content-type 不是 event-stream(舊 core、中間有代理把它
// 緩衝掉)就退回讀一次 JSON,兩條路最後都是同一個 AgentChatOutcome。

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
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 進行中的那一次 /chat。開新對話、重新送出、unmount 都要中止它 —— 不中止的話
   *  一個離開了的畫面仍在 server 上跑 8 步的 loop。 */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 新內容進來就捲到底。串流中把 behavior 換成 auto:smooth 的動畫時間長於兩個
  // token 的間隔,連續呼叫會互相打斷,結果是捲不到底。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      block: "end",
      behavior: streaming ? "auto" : "smooth",
    });
  }, [state.entries.length, busy, streaming]);

  /** 送出目前的 transcript,把回應接上去。永不 throw。 */
  async function runChat(next: TranscriptState): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState(next);
    setBusy(true);
    setTransport(null);
    setStreaming(emptyStreaming());
    try {
      const res = await fetch("/api/admin/agent/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 這一個 header 就是「請串流」。server 沒帶它時的行為與 1.31.0 相同。
          accept: "text/event-stream",
        },
        body: JSON.stringify({ messages: next.messages }),
        signal: controller.signal,
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
      const outcome = await readChatResponse(res, (event) =>
        setStreaming((prev) => (prev ? applyLoopEvent(prev, event) : prev)),
      );
      if (!outcome) {
        // 串流結束卻沒有 outcome —— 對 transcript 而言什麼都沒發生(server 那邊
        // 可能已經做了事,但我們接不回來)。當傳輸層失敗處理,不亂接一段內容。
        setTransport("unknown");
        return;
      }
      setState((prev) => applyChatOutcome(prev, outcome));
    } catch (e) {
      // 自己按下的中止不是錯誤(開新對話 / 離開頁面)。
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setTransport("network");
      }
    } finally {
      // 只有「還是當前這一次」才收尾。被後來的一次取代時,busy/streaming 屬於
      // 那一次,清掉會讓新的請求看起來已經結束。
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(null);
        setBusy(false);
      }
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

  /**
   * 反問卡的兩個出口(spec §4.6)。沒有 /execute 這一步 —— 答案本身就是結果 ——
   * 所以直接補 tool_result 然後續跑 /chat:模型還沒看過這個答案,少了這一步
   * admin 會看到自己按了一個選項然後沒有下文。**關閉走同一條路**,只是內容不同。
   */
  function onAskResolve(decision: AskDecision): void {
    if (!state.pendingAsk || executing || busy) return;
    void runChat(applyAskResolution(state, decision));
  }

  function onAskAnswer(answer: AskAnswer): void {
    onAskResolve({ kind: "answered", answer });
  }

  function onNewChat(): void {
    if (busy || executing) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(emptyTranscript());
    setTransport(null);
    setStreaming(null);
  }

  // 兩種卡都鎖住 composer(一次只處理一張)。文案分開:被鎖住的人要知道自己該
  // 做的是「按確認」還是「回答問題」。
  const lockedNote = state.pending
    ? t("agent.lockedByProposal")
    : state.pendingAsk
      ? t("agent.lockedByAsk")
      : null;
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
              case "ask":
                return (
                  <AskCard
                    key={entry.id}
                    ask={entry.ask}
                    resolution={entry.resolution}
                    answer={entry.answer}
                    running={busy && entry.resolution === "pending"}
                    onAnswer={onAskAnswer}
                    onDismiss={() => onAskResolve({ kind: "dismissed" })}
                  />
                );
              case "notice":
                return <Notice key={entry.id} tone={entry.tone} detail={entry.detail} />;
            }
          })}

          {/* 進行中的一輪。**暫態** —— outcome 一到就整段換成上面的正式條目
              (見檔頭與 stream.ts)。 */}
          {streaming && streaming.text.trim().length > 0 && (
            <MessageBubble variant="assistant" label={t("agent.assistant")} streaming>
              {streaming.text}
            </MessageBubble>
          )}
          {streaming?.status && <StreamStatus status={streaming.status} step={streaming.step} />}

          {transport && <TransportNotice code={transport} />}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[46rem]">
        <Composer
          tools={tools}
          disabled={lockedNote !== null || busy || executing}
          busy={busy}
          lockedNote={lockedNote}
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

/**
 * 讀一次 /chat 的回應,回傳 outcome(讀不到 outcome 時回 null)。
 *
 * 兩種形狀:
 *   · `text/event-stream` → 逐 frame 讀,過程事件交給 onEvent,`event: outcome`
 *     是最後一個。frame 邊界不保證對齊 chunk,所以 buffer 由 splitSseFrames 切
 *     (那支函式有測試釘住切點)。
 *   · 其他 → 讀一次 JSON。舊版 server、或中間有代理把串流整包緩衝掉時的自然降級。
 *
 * 刻意不用 EventSource:它只會 GET,而這個端點是帶 body 的 POST。
 */
async function readChatResponse(
  res: Response,
  onEvent: (event: AgentLoopEvent) => void,
): Promise<AgentChatOutcome | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    return (await res.json()) as AgentChatOutcome;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: AgentChatOutcome | null = null;

  const take = (chunk: string): void => {
    buffer += chunk;
    const { frames, rest } = splitSseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      // 壞掉的一個 frame 不該中斷整條串流:跳過它,後面的照收。
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (frame.event === "outcome") {
        outcome = data as AgentChatOutcome;
        continue;
      }
      onEvent(data as AgentLoopEvent);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return outcome;
}

/**
 * 串流中的狀態行。**靜態文字**,沒有任何會動的東西 —— pulsing / 呼吸 /
 * 打字游標閃爍是 docs/admin-design-language.md 的紅線。等待的語彙沿用面板既有的
 * RingDot + 一句話。
 */
function StreamStatus({
  status,
  step,
}: {
  status: NonNullable<StreamingState["status"]>;
  step: number;
}) {
  const t = useT();
  const label =
    status.kind === "tool"
      ? t("agent.stream.usingTool", { name: status.name })
      : step > 1
        ? t("agent.stream.thinkingStep", { step })
        : t("agent.stream.thinking");
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-black/40">
      <RingDot />
      <span className="truncate">{label}</span>
    </p>
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
