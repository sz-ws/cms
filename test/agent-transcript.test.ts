import { describe, it, expect } from "vitest";

// docs/spec-admin-agent.md Phase D:面板 transcript 純函式的單元測試。
//
// 這一檔的鐵律在第一個 describe:**確認與取消兩條路都不留懸空 tool_use**。
// spec §4 把 transcript 交給前端持有,於是「一個 tool_use 必須有對應的 tool_result」
// 這條上游格式規則變成前端的責任;違反它的懲罰是延遲一拍的 —— 按下取消當下什麼事
// 都不會發生,直到使用者下一次送出訊息才被上游整份拒收。這種錯不能靠人工點測發現,
// 所以斷言直接對著 findDanglingToolUseIds。
//
// 本檔不進 React、不進 fetch:transcript.ts 只 import type(編譯期抹除),因此在
// workers pool 裡是一個純模組。

import {
  CLIENT_TOOL_RESULT_MAX_CHARS,
  appendUserMessage,
  applyAskResolution,
  applyChatOutcome,
  applyProposalResolution,
  canSend,
  emptyTranscript,
  findDanglingToolUseIds,
} from "../src/components/admin/agent/transcript";
import type { TranscriptState } from "../src/components/admin/agent/transcript";
import type {
  AgentAsk,
  AgentChatOutcome,
  AgentProposal,
} from "../src/ext/agent-loop";
import type { AiChatMessage } from "../src/ext/providers/ai";

const PROPOSAL: AgentProposal = {
  toolName: "content.gallery_item.update",
  toolUseId: "toolu_write_1",
  args: { id: "abc", data: { title: "新標題" } },
  summary: "Update one entry — {\"id\":\"abc\"}",
};

/** status:"proposal" 的 /chat 回應。appended 的最後一則 assistant 帶著沒有結果的
 *  tool_use —— 這正是懸空狀態的來源。 */
function proposalOutcome(
  proposal: AgentProposal = PROPOSAL,
  text = "我先確認一下這個更新。",
): AgentChatOutcome {
  return {
    status: "proposal",
    text,
    proposal,
    appended: [
      {
        role: "assistant",
        content: [
          { type: "text", text },
          {
            type: "tool_use",
            id: proposal.toolUseId,
            name: proposal.toolName,
            input: proposal.args,
          },
        ],
      },
    ],
    steps: 1,
    toolCalls: [],
    model: "test-model",
  };
}

/** 走過一次 read 回合再回文字的 /chat 回應。 */
function readThenTextOutcome(): AgentChatOutcome {
  return {
    status: "text",
    text: "找到 3 筆。",
    appended: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我查一下。" },
          { type: "tool_use", id: "toolu_read_1", name: "core.content.search", input: { q: "貓" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_read_1", content: '{"total":3}' },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "找到 3 筆。" }] },
    ],
    steps: 2,
    toolCalls: [{ toolName: "core.content.search", ok: true, truncated: false }],
  };
}

function withPendingProposal(): TranscriptState {
  return applyChatOutcome(
    appendUserMessage(emptyTranscript(), "把 abc 的標題改掉"),
    proposalOutcome(),
  );
}

// ---------------------------------------------------------------------------
// 鐵律
// ---------------------------------------------------------------------------

describe("確認制:兩條路都不留懸空 tool_use", () => {
  it("提案送達之後,transcript 是懸空的(這就是必須補結果的理由)", () => {
    const state = withPendingProposal();
    expect(findDanglingToolUseIds(state.messages)).toEqual(["toolu_write_1"]);
    expect(canSend(state)).toBe(false);
    expect(state.pending).toEqual(PROPOSAL);
  });

  it("按下確認執行 → 補上 tool_result,不再懸空", () => {
    const state = applyProposalResolution(withPendingProposal(), {
      kind: "confirmed",
      ok: true,
      result: { id: "abc" },
    });
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
    expect(canSend(state)).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("按下取消 → 一樣補上 tool_result,不再懸空", () => {
    const state = applyProposalResolution(withPendingProposal(), { kind: "cancelled" });
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
    expect(canSend(state)).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("執行失敗(/execute 回 ok:false)也補結果 —— 失敗不是「沒發生」", () => {
    const state = applyProposalResolution(withPendingProposal(), {
      kind: "confirmed",
      ok: false,
      error: "invalid_args",
    });
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
    const last = state.messages[state.messages.length - 1];
    expect(last.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "toolu_write_1",
      isError: true,
    });
  });
});

describe("補回去的 tool_result 形狀", () => {
  it("確認成功:content 是 JSON 字串、不帶 isError", () => {
    const state = applyProposalResolution(withPendingProposal(), {
      kind: "confirmed",
      ok: true,
      result: { id: "abc", title: "新標題" },
    });
    const block = state.messages[state.messages.length - 1].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type !== "tool_result") throw new Error("unreachable");
    expect(block.isError).toBeUndefined();
    expect(JSON.parse(block.content)).toEqual({
      ok: true,
      result: { id: "abc", title: "新標題" },
    });
  });

  it("取消:content 說明「沒有執行」,且標為 isError 免得被讀成已完成", () => {
    const state = applyProposalResolution(withPendingProposal(), { kind: "cancelled" });
    const block = state.messages[state.messages.length - 1].content[0];
    if (block.type !== "tool_result") throw new Error("unreachable");
    expect(block.isError).toBe(true);
    const parsed = JSON.parse(block.content) as { cancelled: boolean; reason: string };
    expect(parsed.cancelled).toBe(true);
    expect(parsed.reason).toMatch(/declined/i);
  });

  it("超大結果被截斷並標注(不讓一筆 result 撐爆下一輪脈絡)", () => {
    const state = applyProposalResolution(withPendingProposal(), {
      kind: "confirmed",
      ok: true,
      result: "x".repeat(CLIENT_TOOL_RESULT_MAX_CHARS * 3),
    });
    const block = state.messages[state.messages.length - 1].content[0];
    if (block.type !== "tool_result") throw new Error("unreachable");
    expect(block.content.length).toBeLessThan(CLIENT_TOOL_RESULT_MAX_CHARS + 200);
    expect(block.content).toContain("truncated");
  });

  it("沒有待處理提案時,重複處置不會產生第二則 tool_result", () => {
    const once = applyProposalResolution(withPendingProposal(), { kind: "cancelled" });
    const twice = applyProposalResolution(once, { kind: "confirmed", ok: true });
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// delta 累加與渲染條目
// ---------------------------------------------------------------------------

describe("appended 是 delta,前端負責接上去", () => {
  it("使用者訊息 + 回應依序累加,不取代", () => {
    const state = applyChatOutcome(
      appendUserMessage(emptyTranscript(), "有幾筆貓?"),
      readThenTextOutcome(),
    );
    expect(state.messages).toHaveLength(4); // user + assistant + tool_result + assistant
    expect(state.messages[0]).toEqual<AiChatMessage>({
      role: "user",
      content: [{ type: "text", text: "有幾筆貓?" }],
    });
  });

  it("空白訊息不進 transcript(上游拒收空 content)", () => {
    const state = appendUserMessage(emptyTranscript(), "   \n ");
    expect(state).toEqual(emptyTranscript());
  });

  it("兩輪對話串起來仍然是合法的(沒有懸空)", () => {
    const first = applyChatOutcome(
      appendUserMessage(emptyTranscript(), "有幾筆貓?"),
      readThenTextOutcome(),
    );
    const second = applyChatOutcome(
      appendUserMessage(first, "那狗呢?"),
      readThenTextOutcome(),
    );
    expect(findDanglingToolUseIds(second.messages)).toEqual([]);
    expect(canSend(second)).toBe(true);
  });
});

describe("渲染條目", () => {
  it("read 回合攤成 assistant 文字 + 工具呼叫區", () => {
    const state = applyChatOutcome(
      appendUserMessage(emptyTranscript(), "有幾筆貓?"),
      readThenTextOutcome(),
    );
    expect(state.entries.map((e) => e.kind)).toEqual([
      "user",
      "assistant",
      "toolCalls",
      "assistant",
    ]);
    const tools = state.entries.find((e) => e.kind === "toolCalls");
    expect(tools).toMatchObject({
      calls: [{ toolName: "core.content.search", ok: true, truncated: false }],
    });
  });

  it("toolCalls 依 tool_result 的則數對位,不是全部堆在最後", () => {
    const outcome: AgentChatOutcome = {
      status: "text",
      text: "好了。",
      appended: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "a", name: "core.content.search", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "{}" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "b", name: "core.content.get", input: {} },
            { type: "tool_use", id: "c", name: "core.extensions.list", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "b", content: "{}" },
            { type: "tool_result", toolUseId: "c", content: "{}", isError: true },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "好了。" }] },
      ],
      steps: 3,
      toolCalls: [
        { toolName: "core.content.search", ok: true, truncated: false },
        { toolName: "core.content.get", ok: true, truncated: true },
        { toolName: "core.extensions.list", ok: false, error: "boom", truncated: false },
      ],
    };
    const state = applyChatOutcome(emptyTranscript(), outcome);
    const sections = state.entries.filter((e) => e.kind === "toolCalls");
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ calls: [{ toolName: "core.content.search" }] });
    expect(sections[1]).toMatchObject({
      calls: [{ toolName: "core.content.get", truncated: true }, { toolName: "core.extensions.list", ok: false }],
    });
  });

  it("提案卡:模型自己的說法在上,卡片是獨立條目", () => {
    const state = withPendingProposal();
    expect(state.entries.map((e) => e.kind)).toEqual(["user", "assistant", "proposal"]);
    expect(state.entries[1]).toMatchObject({ text: "我先確認一下這個更新。" });
    expect(state.entries[2]).toMatchObject({ resolution: "pending" });
  });

  it("處置後只改動對應 toolUseId 的那一張卡", () => {
    const first = applyProposalResolution(withPendingProposal(), { kind: "cancelled" });
    const second = applyProposalResolution(
      applyChatOutcome(first, proposalOutcome({ ...PROPOSAL, toolUseId: "toolu_write_2" }, "再試一次。")),
      { kind: "confirmed", ok: true, result: null },
    );
    const cards = second.entries.filter((e) => e.kind === "proposal");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ resolution: "cancelled" });
    expect(cards[1]).toMatchObject({ resolution: "confirmed", outcome: { ok: true } });
  });

  it("status:max_steps → 明確的進度告知條目", () => {
    const state = applyChatOutcome(emptyTranscript(), {
      status: "max_steps",
      text: "目前查到…",
      appended: [],
      steps: 8,
      toolCalls: [],
    });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ kind: "notice", tone: "maxSteps" });
  });

  it("status:error → 錯誤碼原樣帶到條目上(面板據此給專屬提示)", () => {
    const state = applyChatOutcome(emptyTranscript(), {
      status: "error",
      error: "tool_use_not_supported",
      appended: [],
      steps: 1,
      toolCalls: [],
    });
    expect(state.entries[0]).toMatchObject({
      kind: "notice",
      tone: "error",
      detail: "tool_use_not_supported",
    });
  });

  it("錯誤發生前已跑完的步驟仍接進 transcript(不丟掉已付出的等待)", () => {
    const state = applyChatOutcome(emptyTranscript(), {
      status: "error",
      error: "timeout",
      appended: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "a", name: "core.content.search", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "{}" }] },
      ],
      steps: 2,
      toolCalls: [{ toolName: "core.content.search", ok: true, truncated: false }],
    });
    expect(state.messages).toHaveLength(2);
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
  });
});

describe("純度", () => {
  it("entry id 由狀態序號決定,同輸入同輸出", () => {
    const a = applyChatOutcome(appendUserMessage(emptyTranscript(), "hi"), readThenTextOutcome());
    const b = applyChatOutcome(appendUserMessage(emptyTranscript(), "hi"), readThenTextOutcome());
    expect(a).toEqual(b);
    expect(new Set(a.entries.map((e) => e.id)).size).toBe(a.entries.length);
  });

  it("reducer 不修改輸入", () => {
    const before = withPendingProposal();
    const snapshot = structuredClone(before);
    applyProposalResolution(before, { kind: "cancelled" });
    expect(before).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 反問卡(spec §4.6)
// ---------------------------------------------------------------------------

// 同一條鐵律,另一張卡:**回答與關閉兩條路都補 tool_result**。差別只在內容 ——
// 拒答是合法資料(admin 就是不想回答),不是錯誤,所以那一則不帶 isError。

const ASK: AgentAsk = {
  question: "要改哪一篇?",
  options: [
    { value: "cat", label: "貓の日常" },
    { value: "dog", label: "狗の日常", hint: "上週那篇" },
  ],
};

const ASK_FORM: AgentAsk = {
  question: "新的標題與說明?",
  fields: [
    { key: "title", label: "標題", required: true },
    { key: "note", label: "說明", type: "textarea" },
  ],
};

function askOutcome(ask: AgentAsk = ASK, toolUseId = "toolu_ask_1"): AgentChatOutcome {
  return {
    status: "ask",
    text: "我不確定是哪一篇。",
    ask,
    toolUseId,
    appended: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我不確定是哪一篇。" },
          { type: "tool_use", id: toolUseId, name: "core.ui.ask", input: ask },
        ],
      },
    ],
    steps: 1,
    toolCalls: [],
    model: "test-model",
  };
}

function withPendingAsk(ask: AgentAsk = ASK): TranscriptState {
  return applyChatOutcome(
    appendUserMessage(emptyTranscript(), "幫我改一下標題"),
    askOutcome(ask),
  );
}

/** 最後一則訊息的第一個 block,已確認是 tool_result。 */
function lastResult(state: TranscriptState) {
  const block = state.messages[state.messages.length - 1].content[0];
  if (block.type !== "tool_result") throw new Error("unreachable");
  return block;
}

describe("反問卡:兩條路都不留懸空 tool_use", () => {
  it("卡片送達之後 transcript 是懸空的,composer 鎖住", () => {
    const state = withPendingAsk();
    expect(findDanglingToolUseIds(state.messages)).toEqual(["toolu_ask_1"]);
    expect(canSend(state)).toBe(false);
    expect(state.pendingAsk).toEqual({ ask: ASK, toolUseId: "toolu_ask_1" });
    expect(state.pending).toBeNull();
    expect(state.entries.map((e) => e.kind)).toEqual(["user", "assistant", "ask"]);
    expect(state.entries[2]).toMatchObject({ resolution: "pending", ask: ASK });
  });

  it("回答 → 補上 tool_result,不再懸空", () => {
    const state = applyAskResolution(withPendingAsk(), {
      kind: "answered",
      answer: { choice: "cat" },
    });
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
    expect(canSend(state)).toBe(true);
    expect(state.pendingAsk).toBeNull();
  });

  it("關閉 → 一樣補上 tool_result,不再懸空", () => {
    const state = applyAskResolution(withPendingAsk(), { kind: "dismissed" });
    expect(findDanglingToolUseIds(state.messages)).toEqual([]);
    expect(canSend(state)).toBe(true);
    expect(state.pendingAsk).toBeNull();
  });
});

describe("反問卡補回去的 tool_result 形狀", () => {
  it("選了一個選項:answered:true + choice,**不帶 isError**", () => {
    const block = lastResult(
      applyAskResolution(withPendingAsk(), {
        kind: "answered",
        answer: { choice: "cat" },
      }),
    );
    expect(block.toolUseId).toBe("toolu_ask_1");
    expect(block.isError).toBeUndefined();
    expect(JSON.parse(block.content)).toEqual({ answered: true, choice: "cat" });
  });

  it("自由輸入與表單:各自的欄位原樣回去", () => {
    const free = lastResult(
      applyAskResolution(withPendingAsk(), {
        kind: "answered",
        answer: { freeText: "都不是,是三月那篇" },
      }),
    );
    expect(JSON.parse(free.content)).toEqual({
      answered: true,
      freeText: "都不是,是三月那篇",
    });

    const form = lastResult(
      applyAskResolution(withPendingAsk(ASK_FORM), {
        kind: "answered",
        answer: { values: { title: "新標題", note: "" } },
      }),
    );
    expect(JSON.parse(form.content)).toEqual({
      answered: true,
      values: { title: "新標題", note: "" },
    });
  });

  it("關閉:answered:false + 原因,**仍然不是錯誤**(與提案取消相反)", () => {
    const block = lastResult(
      applyAskResolution(withPendingAsk(), { kind: "dismissed" }),
    );
    expect(block.isError).toBeUndefined();
    const parsed = JSON.parse(block.content) as { answered: boolean; reason: string };
    expect(parsed.answered).toBe(false);
    expect(parsed.reason).toMatch(/dismissed/i);
  });

  it("超長的自由輸入被截斷並標注", () => {
    const block = lastResult(
      applyAskResolution(withPendingAsk(), {
        kind: "answered",
        answer: { freeText: "字".repeat(CLIENT_TOOL_RESULT_MAX_CHARS * 2) },
      }),
    );
    expect(block.content.length).toBeLessThan(CLIENT_TOOL_RESULT_MAX_CHARS + 200);
    expect(block.content).toContain("truncated");
  });

  it("沒有待回答的卡時,重複處置不會產生第二則 tool_result", () => {
    const once = applyAskResolution(withPendingAsk(), { kind: "dismissed" });
    const twice = applyAskResolution(once, {
      kind: "answered",
      answer: { choice: "cat" },
    });
    expect(twice).toBe(once);
  });
});

describe("反問卡的渲染條目", () => {
  it("解決後只改動對應 toolUseId 的那一張卡,並記下選了什麼", () => {
    const first = applyAskResolution(withPendingAsk(), { kind: "dismissed" });
    const second = applyAskResolution(
      applyChatOutcome(first, askOutcome(ASK, "toolu_ask_2")),
      { kind: "answered", answer: { choice: "dog" } },
    );
    const cards = second.entries.filter((e) => e.kind === "ask");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ resolution: "dismissed" });
    expect(cards[0]).not.toHaveProperty("answer");
    expect(cards[1]).toMatchObject({
      resolution: "answered",
      answer: { choice: "dog" },
    });
  });

  it("回答之後可以再送下一則訊息,transcript 仍然合法", () => {
    const answered = applyAskResolution(withPendingAsk(), {
      kind: "answered",
      answer: { choice: "cat" },
    });
    const next = applyChatOutcome(
      appendUserMessage(answered, "那就改那一篇"),
      readThenTextOutcome(),
    );
    expect(findDanglingToolUseIds(next.messages)).toEqual([]);
    expect(canSend(next)).toBe(true);
  });

  it("純度:同輸入同輸出,而且不修改輸入", () => {
    const a = applyAskResolution(withPendingAsk(), {
      kind: "answered",
      answer: { choice: "cat" },
    });
    const b = applyAskResolution(withPendingAsk(), {
      kind: "answered",
      answer: { choice: "cat" },
    });
    expect(a).toEqual(b);

    const before = withPendingAsk();
    const snapshot = structuredClone(before);
    applyAskResolution(before, { kind: "dismissed" });
    expect(before).toEqual(snapshot);
  });
});
