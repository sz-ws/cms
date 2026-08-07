import type { AiChatContentBlock, AiChatMessage } from "@/ext/providers/ai";
import type {
  AgentChatOutcome,
  AgentProposal,
  AgentToolCallLog,
} from "@/ext/agent-loop";

// docs/spec-admin-agent.md §5:面板的 transcript 維護,抽成純函式。
//
// ── 為什麼這件事值得一個獨立、無 React 的模組 ────────────────────────────────
// spec §4 把 transcript 放在前端(server stateless),於是「對話長什麼樣」變成前端
// 的責任。其中有一條規則錯了就會讓**下一次** /chat 被上游整份拒收:
//
//     一個 tool_use 必須有對應的 tool_result。
//
// 確認卡有兩個出口(確認執行、取消),兩條路都必須補上結果 —— 取消也要補。少補
// 一條,錯誤不會在按下的當下出現,而是在使用者下一次送出訊息時,以一句看不懂的
// 上游錯誤現身。這種「延遲一拍才炸」的規則不能只靠事件處理器碰巧寫對,要有測試
// 釘住;所以它住在一個沒有 React、沒有 fetch、沒有 DOM 的檔案裡。
//
// ── 兩份資料,一個真相 ──────────────────────────────────────────────────────
// state 同時帶 `messages`(送去 /chat 的線上形狀)與 `entries`(渲染用的條目)。
// 看起來像重複,但兩者承載的東西不同:messages 是上游要的、必須合法的;entries 帶
// 的是只有這一輪回應才知道、而 messages 裡表達不出來的東西(工具是否失敗、結果有
// 沒有被截斷、提案被確認還是取消)。要嘛在渲染時反推(推不出來),要嘛留著 ——
// 留著,並且讓 entries 永遠由 messages 的同一次更新一起產生。
//
// 純度:不呼叫 randomUUID / Date.now。entry id 由 state 自帶的序號產生,同樣的
// 輸入永遠得到同樣的輸出 —— 測試因此可以直接比對整份 state。

/** tool_result 內文上限(字元)。/chat route 的單塊上限是 24_000,這裡取遠小於它
 *  的值:確認卡的執行結果會原樣進下一輪脈絡,一筆大 result 撐爆的是模型的注意力,
 *  不是 HTTP body。與 agent-loop 的 TOOL_RESULT_MAX_CHARS 同量級,刻意不共用常數
 *  —— 那邊是 server 對自己產物的紀律,這邊是前端對使用者資料的紀律。 */
export const CLIENT_TOOL_RESULT_MAX_CHARS = 4_000;

/** 提案的處置。pending = 卡片還在等人按。 */
export type ProposalResolution = "pending" | "confirmed" | "cancelled";

/** 提案執行後的結果摘要(渲染用;真正接回 LLM 的是 messages 裡的 tool_result)。 */
export interface ProposalOutcome {
  ok: boolean;
  /** 成功時的結果 JSON / 失敗時的錯誤碼,已截斷。 */
  detail: string;
}

/** 渲染用的條目。UI 只認識這個 union,不必自己解析 content blocks。 */
export type TranscriptEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "toolCalls"; id: string; calls: AgentToolCallLog[] }
  | {
      kind: "proposal";
      id: string;
      proposal: AgentProposal;
      resolution: ProposalResolution;
      outcome?: ProposalOutcome;
    }
  | {
      kind: "notice";
      id: string;
      tone: "maxSteps" | "error";
      /** tone:"error" 時的錯誤碼(not_configured / tool_use_not_supported / 上游摘要)。 */
      detail?: string;
    };

export interface TranscriptState {
  /** 送去 /chat 的完整 transcript。 */
  messages: AiChatMessage[];
  entries: TranscriptEntry[];
  /** 待人工確認的提案;非 null 時 composer 必須鎖住(一次只處理一張卡)。 */
  pending: AgentProposal | null;
  /** 下一個 entry id 的序號(見檔頭的純度說明)。 */
  seq: number;
}

/** 確認卡按下之後的決定。confirmed 帶 /execute 的回應,cancelled 什麼都不帶。 */
export type ProposalDecision =
  | { kind: "confirmed"; ok: boolean; result?: unknown; error?: string }
  | { kind: "cancelled" };

export function emptyTranscript(): TranscriptState {
  return { messages: [], entries: [], pending: null, seq: 0 };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function textOf(message: AiChatMessage): string {
  return message.content
    .filter((b): b is Extract<AiChatContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    // 迴圈參照 / BigInt。丟掉內容也要留下形狀,模型看得到「有東西但讀不到」。
    return '"[unserializable result]"';
  }
}

/** 超限截斷並**標注**。標注不是禮貌:模型看不到自己收到的是半份資料時,會把它
 *  當成完整事實,然後基於那個事實提下一個案(同 agent-loop 的 boundedResult)。 */
function bounded(raw: string): string {
  if (raw.length <= CLIENT_TOOL_RESULT_MAX_CHARS) return raw;
  return `${raw.slice(0, CLIENT_TOOL_RESULT_MAX_CHARS)}\n…[truncated: showing ${CLIENT_TOOL_RESULT_MAX_CHARS} of ${raw.length} characters]`;
}

/**
 * transcript 裡沒有對應 tool_result 的 tool_use id。
 *
 * 這是「這份對話送得出去嗎」的判準,不是除錯輔助:懸空的 tool_use 會讓上游拒收
 * 整份請求。面板在送出前拿它當守門(見 canSend),測試拿它當斷言。
 */
export function findDanglingToolUseIds(messages: readonly AiChatMessage[]): string[] {
  const answered = new Set<string>();
  const used: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") used.push(block.id);
      else if (block.type === "tool_result") answered.add(block.toolUseId);
    }
  }
  return used.filter((id) => !answered.has(id));
}

/** 可以送出下一則訊息嗎。有待確認的卡、或有懸空的 tool_use 都不行。 */
export function canSend(state: TranscriptState): boolean {
  return state.pending === null && findDanglingToolUseIds(state.messages).length === 0;
}

// ---------------------------------------------------------------------------
// entries 的組裝
// ---------------------------------------------------------------------------

interface EntryBuilder {
  entries: TranscriptEntry[];
  seq: number;
}

function pushEntry(
  builder: EntryBuilder,
  make: (id: string) => TranscriptEntry,
): EntryBuilder {
  return {
    entries: [...builder.entries, make(`e${builder.seq}`)],
    seq: builder.seq + 1,
  };
}

/**
 * 把這一輪新增的訊息(delta)攤成渲染條目。
 *
 * toolCalls 的歸位是精確的、不是猜的:loop 把一個 assistant 回合的所有 tool_result
 * 塞進緊接的**同一則** user 訊息(上游的格式要求),所以那一則訊息裡有幾個
 * tool_result,就對應 outcome.toolCalls 的接下來幾筆。依序消耗即可對齊。
 */
function foldAppended(
  builder: EntryBuilder,
  appended: readonly AiChatMessage[],
  toolCalls: readonly AgentToolCallLog[],
): EntryBuilder {
  let next = builder;
  let logIndex = 0;

  for (const message of appended) {
    if (message.role === "assistant") {
      const text = textOf(message);
      if (text) next = pushEntry(next, (id) => ({ kind: "assistant", id, text }));
      continue;
    }
    const resultCount = message.content.filter((b) => b.type === "tool_result").length;
    const calls = toolCalls.slice(logIndex, logIndex + resultCount);
    logIndex += resultCount;
    if (calls.length > 0) {
      next = pushEntry(next, (id) => ({ kind: "toolCalls", id, calls: [...calls] }));
    }
  }

  // 對不上的殘餘(理論上不會有:每一筆 log 都來自一個 tool_result)。寧可多渲染
  // 一段也不要靜默吞掉 —— 吞掉的話「agent 到底查了什麼」就不見了。
  const rest = toolCalls.slice(logIndex);
  if (rest.length > 0) {
    next = pushEntry(next, (id) => ({ kind: "toolCalls", id, calls: [...rest] }));
  }
  return next;
}

// ---------------------------------------------------------------------------
// 對外的三個 reducer
// ---------------------------------------------------------------------------

/** 使用者送出一則訊息。空白字串不進 transcript(上游會拒收空 content)。 */
export function appendUserMessage(
  state: TranscriptState,
  text: string,
): TranscriptState {
  const trimmed = text.trim();
  if (trimmed.length === 0) return state;
  const built = pushEntry(
    { entries: state.entries, seq: state.seq },
    (id) => ({ kind: "user", id, text: trimmed }),
  );
  return {
    messages: [...state.messages, { role: "user", content: [{ type: "text", text: trimmed }] }],
    entries: built.entries,
    seq: built.seq,
    pending: state.pending,
  };
}

/**
 * 套用一次 /chat 的回應。
 *
 * `appended` 是 delta(agent-loop 檔頭明言),所以這裡是 concat 而不是取代。四種
 * status 都會走到這裡:即使 status:"error",loop 已經跑完的那幾步仍是合法的
 * assistant/tool_result 配對,接上去才不會把使用者已經付出的等待丟掉。
 */
export function applyChatOutcome(
  state: TranscriptState,
  outcome: AgentChatOutcome,
): TranscriptState {
  let built = foldAppended(
    { entries: state.entries, seq: state.seq },
    outcome.appended,
    outcome.toolCalls,
  );
  let pending = state.pending;

  if (outcome.status === "proposal") {
    pending = outcome.proposal;
    built = pushEntry(built, (id) => ({
      kind: "proposal",
      id,
      proposal: outcome.proposal,
      resolution: "pending",
    }));
  } else if (outcome.status === "max_steps") {
    built = pushEntry(built, (id) => ({ kind: "notice", id, tone: "maxSteps" }));
  } else if (outcome.status === "error") {
    built = pushEntry(built, (id) => ({
      kind: "notice",
      id,
      tone: "error",
      detail: outcome.error,
    }));
  }

  return {
    messages: [...state.messages, ...outcome.appended],
    entries: built.entries,
    seq: built.seq,
    pending,
  };
}

/** 決定 → 要接回 transcript 的 tool_result 內文 + 渲染用摘要。 */
function decisionResult(decision: ProposalDecision): {
  content: string;
  isError: boolean;
  outcome: ProposalOutcome;
} {
  if (decision.kind === "cancelled") {
    // 取消也是一種結果。內文寫成人話而不只是 `{"cancelled":true}`:模型接著要決定
    // 「換個做法還是問清楚」,而它唯一的線索就是這段字。
    const content = jsonText({
      cancelled: true,
      reason: "The administrator declined this action. Nothing was executed.",
    });
    // isError:true 是刻意的 —— 沒有它,模型很容易把一個帶 cancelled 欄位的成功
    // 回應讀成「做完了」,然後在下一句向 admin 回報一件從未發生的事。
    return { content, isError: true, outcome: { ok: false, detail: content } };
  }
  if (decision.ok) {
    const content = bounded(jsonText({ ok: true, result: decision.result ?? null }));
    return { content, isError: false, outcome: { ok: true, detail: content } };
  }
  const content = bounded(jsonText({ ok: false, error: decision.error ?? "unknown_error" }));
  return { content, isError: true, outcome: { ok: false, detail: content } };
}

/**
 * 處置目前這張確認卡(確認執行完成、或取消)。
 *
 * **兩條路都會補一則 tool_result** —— 這是本模組存在的理由(見檔頭)。沒有待處理
 * 的提案時原樣回傳:重複點擊、或先按取消再按確認的競態,都不該產生第二則結果。
 */
export function applyProposalResolution(
  state: TranscriptState,
  decision: ProposalDecision,
): TranscriptState {
  const pending = state.pending;
  if (!pending) return state;

  const { content, isError, outcome } = decisionResult(decision);
  const resultMessage: AiChatMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: pending.toolUseId,
        content,
        ...(isError ? { isError: true } : {}),
      },
    ],
  };

  const resolution: ProposalResolution =
    decision.kind === "cancelled" ? "cancelled" : "confirmed";

  // 更新那一張卡的狀態。用 toolUseId 對位而不是「最後一個 proposal entry」——
  // 對位錯誤在畫面上是「另一張卡變成已執行」,那比不更新更糟。
  let patched = false;
  const entries = state.entries.map((entry) => {
    if (patched || entry.kind !== "proposal") return entry;
    if (entry.proposal.toolUseId !== pending.toolUseId) return entry;
    if (entry.resolution !== "pending") return entry;
    patched = true;
    return { ...entry, resolution, outcome };
  });

  return {
    messages: [...state.messages, resultMessage],
    entries,
    seq: state.seq,
    pending: null,
  };
}
