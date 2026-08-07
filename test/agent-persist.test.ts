import { describe, it, expect } from "vitest";

// docs/spec-admin-agent.md §5:面板 transcript 落地 localStorage 的單元測試。
//
// 這一檔的鐵律與 agent-transcript.test.ts 是同一條,只是換了一個入口:
//
//     還原出來的 state,不能帶著懸空的 tool_use。
//
// 差別在於威脅模型。transcript.ts 面對的是「我們自己的事件處理器有沒有寫對」,
// 本檔面對的是**一條我們控制不了的通道**:localStorage 裡的字串可以被手動改、可以
// 是舊版本寫的、可以被瀏覽器截斷。所以斷言的形狀是「要嘛回 null,要嘛回一份合法的
// state」,而不是「回一份跟我們寫進去時一樣的東西」。
//
// 下面第二個 describe 是刻意寫成性質測試的:對一份合法 payload 的 messages 逐一位置
// 截斷,每一種截法都必須落在那兩個結果之一。手挑幾個壞例子只能證明那幾個被擋住了。
//
// 本檔不進 React、不進 DOM:persist.ts 的 serialize/deserialize 是純函式,
// localStorage 只出現在該檔最下面幾個 I/O 函式裡(那幾個自己 guard,不在這裡測)。

import {
  AGENT_TRANSCRIPT_KEY_PREFIX,
  AGENT_TRANSCRIPT_MAX_CHARS,
  deserializeTranscript,
  isRestorableState,
  serializeTranscript,
  transcriptStorageKey,
} from "../src/components/admin/agent/persist";
import {
  appendUserMessage,
  applyChatOutcome,
  applyCodeResolution,
  applyProposalResolution,
  canSend,
  emptyTranscript,
  findDanglingToolUseIds,
} from "../src/components/admin/agent/transcript";
import type { TranscriptState } from "../src/components/admin/agent/transcript";
import type {
  AgentAsk,
  AgentChatOutcome,
  AgentCode,
  AgentProposal,
} from "../src/ext/agent-loop";

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

const PROPOSAL: AgentProposal = {
  toolName: "content.gallery_item.update",
  toolUseId: "toolu_write_1",
  args: { id: "abc", data: { title: "新標題" } },
  summary: 'Update one entry — {"id":"abc"}',
};

const ASK: AgentAsk = {
  question: "要改哪一筆?",
  options: [
    { value: "abc", label: "貓" },
    { value: "def", label: "狗", hint: "上週建的那一筆" },
  ],
};

/** 一輪 read:助理呼叫工具 → 結果接回 → 助理回話。resultChars 用來灌大 payload。 */
function readTurn(index: number, resultChars = 24): AgentChatOutcome {
  const id = `toolu_read_${index}`;
  return {
    status: "text",
    text: `第 ${index} 輪的答案。`,
    appended: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我查一下。" },
          { type: "tool_use", id, name: "core.content.search", input: { q: "貓" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: id, content: "x".repeat(resultChars) },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: `第 ${index} 輪的答案。` }] },
    ],
    steps: 2,
    toolCalls: [{ toolName: "core.content.search", ok: true, truncated: false }],
  };
}

function proposalOutcome(): AgentChatOutcome {
  return {
    status: "proposal",
    text: "我先確認一下這個更新。",
    proposal: PROPOSAL,
    appended: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先確認一下這個更新。" },
          {
            type: "tool_use",
            id: PROPOSAL.toolUseId,
            name: PROPOSAL.toolName,
            input: PROPOSAL.args,
          },
        ],
      },
    ],
    steps: 1,
    toolCalls: [],
  };
}

function askOutcome(): AgentChatOutcome {
  return {
    status: "ask",
    text: "",
    ask: ASK,
    toolUseId: "toolu_ask_1",
    appended: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ask_1", name: "core.ui.ask", input: ASK },
        ],
      },
    ],
    steps: 1,
    toolCalls: [],
  };
}

/** n 輪一問一答的正常對話。 */
function conversation(turns: number, resultChars = 24): TranscriptState {
  let state = emptyTranscript();
  for (let i = 0; i < turns; i++) {
    state = appendUserMessage(state, `第 ${i} 個問題`);
    state = applyChatOutcome(state, readTurn(i, resultChars));
  }
  return state;
}

/** 走一趟 serialize → JSON.parse,讓測試能直接動 payload(繞過 serialize 的守門)。 */
function payloadOf(state: TranscriptState): { v: number; state: TranscriptState } {
  const raw = serializeTranscript(state);
  if (raw === null) throw new Error("fixture should be serializable");
  return JSON.parse(raw) as { v: number; state: TranscriptState };
}

function restoreFrom(payload: unknown): TranscriptState | null {
  return deserializeTranscript(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// 來回
// ---------------------------------------------------------------------------

describe("正常來回", () => {
  it("一般對話原封不動地回來", () => {
    const state = conversation(3);
    const raw = serializeTranscript(state);
    expect(raw).not.toBeNull();
    expect(deserializeTranscript(raw as string)).toEqual(state);
  });

  it("待確認的提案跟著回來 —— 卡片還在,而且仍然鎖著 composer", () => {
    const state = applyChatOutcome(
      appendUserMessage(conversation(1), "把 abc 的標題改掉"),
      proposalOutcome(),
    );
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored).toEqual(state);
    expect(restored?.pending).toEqual(PROPOSAL);
    // 這一個懸空是**合法的**:它就是那張卡在等的東西(spec §8:/execute 不綁 hash,
    // 所以隔天才被按下的確認卡走的是同一條路)。
    expect(findDanglingToolUseIds(restored!.messages)).toEqual([PROPOSAL.toolUseId]);
    expect(canSend(restored!)).toBe(false);
  });

  it("待回答的反問卡跟著回來", () => {
    const state = applyChatOutcome(appendUserMessage(emptyTranscript(), "改一下"), askOutcome());
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored).toEqual(state);
    expect(restored?.pendingAsk).toEqual({ ask: ASK, toolUseId: "toolu_ask_1" });
  });

  it("卡片處置過之後的 state 也回得來,而且可以繼續送", () => {
    const state = applyProposalResolution(
      applyChatOutcome(appendUserMessage(emptyTranscript(), "改"), proposalOutcome()),
      { kind: "confirmed", ok: true, result: { id: "abc" } },
    );
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored).toEqual(state);
    expect(canSend(restored!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 鐵律:被截斷 / 被污染的 payload
// ---------------------------------------------------------------------------

describe("鐵律:還原結果不是 null,就是一份送得出去的 state", () => {
  it("messages 從任何一個位置截斷,都落在那兩個結果之一", () => {
    const payload = payloadOf(conversation(3));
    const full = payload.state.messages;
    // 逐一位置截斷 = 模擬「寫到一半」「被別的東西改過」的所有前綴。
    for (let cut = 0; cut <= full.length; cut++) {
      const restored = restoreFrom({
        ...payload,
        state: { ...payload.state, messages: full.slice(0, cut) },
      });
      if (restored === null) continue;
      expect(findDanglingToolUseIds(restored.messages)).toEqual([]);
    }
  });

  it("tool_result 的 toolUseId 被改掉 → 整包丟掉", () => {
    const payload = payloadOf(conversation(2));
    // 對照:fixture 裡真的有 tool_result 可以改(不然下面改了個寂寞)。
    expect(
      payload.state.messages.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(true);
    const messages = payload.state.messages.map((message) => ({
      ...message,
      content: message.content.map((block) =>
        block.type === "tool_result" ? { ...block, toolUseId: "toolu_gone" } : block,
      ),
    }));
    expect(restoreFrom({ ...payload, state: { ...payload.state, messages } })).toBeNull();
  });

  it("pending 指向一個已經有結果的 tool_use → 整包丟掉(按下確認會補出第二則結果)", () => {
    const payload = payloadOf(conversation(1));
    const pending: AgentProposal = { ...PROPOSAL, toolUseId: "toolu_read_0" };
    expect(restoreFrom({ ...payload, state: { ...payload.state, pending } })).toBeNull();
  });

  it("pending 指向一個根本不存在的 tool_use → 整包丟掉", () => {
    const payload = payloadOf(conversation(1));
    const pending: AgentProposal = { ...PROPOSAL, toolUseId: "toolu_nowhere" };
    expect(restoreFrom({ ...payload, state: { ...payload.state, pending } })).toBeNull();
  });

  it("兩張卡同時待處理 → 整包丟掉(loop 一輪最多攔一個 tool_use)", () => {
    const state = applyChatOutcome(
      appendUserMessage(emptyTranscript(), "改"),
      proposalOutcome(),
    );
    const payload = payloadOf(state);
    expect(
      restoreFrom({
        ...payload,
        state: {
          ...payload.state,
          pendingAsk: { ask: ASK, toolUseId: PROPOSAL.toolUseId },
        },
      }),
    ).toBeNull();
  });

  it("entry id 重複 → 整包丟掉(React key 撞號)", () => {
    const payload = payloadOf(conversation(2));
    const entries = payload.state.entries.map((entry) => ({ ...entry, id: "e0" }));
    expect(restoreFrom({ ...payload, state: { ...payload.state, entries } })).toBeNull();
  });

  it("seq 倒退 → 整包丟掉(下一個條目會與舊條目撞號)", () => {
    const payload = payloadOf(conversation(2));
    expect(restoreFrom({ ...payload, state: { ...payload.state, seq: 0 } })).toBeNull();
  });
});

describe("形狀不對就整包丟掉,絕不 render 半殘的 state", () => {
  it("不是 JSON", () => {
    expect(deserializeTranscript("{ not json")).toBeNull();
    expect(deserializeTranscript("")).toBeNull();
  });

  it("版本不符(舊版本寫的東西)", () => {
    const payload = payloadOf(conversation(1));
    expect(restoreFrom({ ...payload, v: 0 })).toBeNull();
    expect(restoreFrom({ ...payload, v: 99 })).toBeNull();
    expect(restoreFrom({ state: payload.state })).toBeNull();
  });

  it("缺欄位 / 型別不對", () => {
    const payload = payloadOf(conversation(1));
    expect(restoreFrom({ ...payload, state: { ...payload.state, entries: "nope" } })).toBeNull();
    expect(restoreFrom({ ...payload, state: { ...payload.state, seq: -1 } })).toBeNull();
    expect(restoreFrom({ ...payload, state: { messages: [], seq: 0 } })).toBeNull();
    expect(restoreFrom(null)).toBeNull();
    expect(restoreFrom([])).toBeNull();
  });

  it("不認得的 entry kind", () => {
    const payload = payloadOf(conversation(1));
    const entries = [...payload.state.entries, { kind: "banner", id: "e99", text: "hi" }];
    expect(restoreFrom({ ...payload, state: { ...payload.state, entries } })).toBeNull();
  });

  it("結果卡的 display 壞掉 → 整包丟掉(半殘的圖表比沒有圖表更誤導)", () => {
    const payload = payloadOf(conversation(1));
    // 對照組先立起來:這個 fixture 真的有一筆工具呼叫可以掛 display,而且掛一份
    // **合法**的 display 是會過的 —— 否則下面那個 toBeNull() 只是在測別的東西。
    const withDisplay = (display: unknown) =>
      payload.state.entries.map((entry) =>
        entry.kind === "toolCalls"
          ? { ...entry, calls: entry.calls.map((call) => ({ ...call, display })) }
          : entry,
      );
    expect(payload.state.entries.some((entry) => entry.kind === "toolCalls")).toBe(true);
    expect(
      restoreFrom({
        ...payload,
        state: {
          ...payload.state,
          entries: withDisplay({
            kind: "trend",
            preset: "stat-simple",
            data: { label: "文章", value: 42 },
          }),
        },
      }),
    ).not.toBeNull();

    expect(
      restoreFrom({
        ...payload,
        state: {
          ...payload.state,
          // label 空字串 + 缺 segments:agent-display 的守門擋得下來。
          entries: withDisplay({ kind: "proportion", preset: "donut", data: { label: "" } }),
        },
      }),
    ).toBeNull();
  });

  it("反問卡同時給 options 與 fields → 整包丟掉(那張卡畫不出來)", () => {
    const state = applyChatOutcome(appendUserMessage(emptyTranscript(), "改"), askOutcome());
    const payload = payloadOf(state);
    const broken = {
      ...ASK,
      fields: [{ key: "title", label: "標題" }],
    };
    expect(
      restoreFrom({
        ...payload,
        state: {
          ...payload.state,
          pendingAsk: { ask: broken, toolUseId: "toolu_ask_1" },
        },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 容量
// ---------------------------------------------------------------------------

describe("容量上限:砍最舊的幾輪,而且砍完仍然合法", () => {
  it("超標的長對話 → 砍到上限之內,結果沒有懸空的 tool_use", () => {
    const state = conversation(12, 60_000);
    const raw = serializeTranscript(state);
    expect(raw).not.toBeNull();
    expect((raw as string).length).toBeLessThanOrEqual(AGENT_TRANSCRIPT_MAX_CHARS);

    const restored = deserializeTranscript(raw as string);
    expect(restored).not.toBeNull();
    expect(findDanglingToolUseIds(restored!.messages)).toEqual([]);
    expect(canSend(restored!)).toBe(true);
    // 真的有砍到東西,而且砍的是**前面**:留下來的第一則是一次使用者送出。
    expect(restored!.messages.length).toBeLessThan(state.messages.length);
    expect(restored!.entries.length).toBeLessThan(state.entries.length);
    expect(restored!.messages[0].content[0]).toMatchObject({ type: "text" });
    expect(restored!.entries[0].kind).toBe("user");
    // messages 與 entries 砍在同一次送出上:兩邊剩下的使用者回合數一樣多。
    const userSends = restored!.messages.filter(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
    ).length;
    expect(restored!.entries.filter((e) => e.kind === "user").length).toBe(userSends);
  });

  it("砍完仍帶著待確認的卡:那張卡活下來,而且仍是唯一合法的懸空", () => {
    const state = applyChatOutcome(
      appendUserMessage(conversation(12, 60_000), "把 abc 的標題改掉"),
      proposalOutcome(),
    );
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored?.pending).toEqual(PROPOSAL);
    expect(findDanglingToolUseIds(restored!.messages)).toEqual([PROPOSAL.toolUseId]);
    expect(restored!.entries.length).toBeLessThan(state.entries.length);
  });

  it("砍到只剩一輪還是超標 → 什麼都不存(不存至少不會壞)", () => {
    expect(serializeTranscript(conversation(1, AGENT_TRANSCRIPT_MAX_CHARS + 1))).toBeNull();
    expect(serializeTranscript(conversation(2, AGENT_TRANSCRIPT_MAX_CHARS + 1))).toBeNull();
  });

  it("不合法的 state 連寫都不寫(壞掉的東西不留到下一次)", () => {
    const state = conversation(2);
    const broken: TranscriptState = {
      ...state,
      // 憑空多一個沒有結果的 tool_use,而且沒有任何卡片在等它。
      messages: [
        ...state.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_orphan", name: "x", input: {} }],
        },
      ],
    };
    expect(isRestorableState(broken)).toBe(false);
    expect(serializeTranscript(broken)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

describe("key 綁使用者", () => {
  it("不同使用者拿到不同的 key —— 同一台機器換人登入撿不到別人的對話", () => {
    expect(transcriptStorageKey("u_aaa")).toBe(`${AGENT_TRANSCRIPT_KEY_PREFIX}u_aaa`);
    expect(transcriptStorageKey("u_aaa")).not.toBe(transcriptStorageKey("u_bbb"));
  });

  it("前綴帶版本,而且掃得到自己寫過的東西", () => {
    expect(AGENT_TRANSCRIPT_KEY_PREFIX.startsWith("sz.agent.transcript.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JS 沙盒卡(spec §4.7)
// ---------------------------------------------------------------------------

// 沙盒卡在 localStorage 這一側有一件事與另外兩張卡不同:**還原出來的待執行卡會自己
// 跑完**(面板一掛載就執行、補結果、續跑 /chat)。之所以可以接受,正是這個功能的前提
// 本身 —— 那段程式碼沒有副作用,重跑一次與跑第一次是同一件事。對照組是「不存
// pendingCode」:那樣還原出來的 transcript 帶著懸空的 tool_use,整份對話只能整包丟掉。
//
// 所以這裡要釘的與另外兩張卡一樣:它回得來、它那一個懸空是合法的、指錯地方就整包丟掉。

const CODE: AgentCode = { code: "[1,2,3].reduce((a,b)=>a+b,0)", reason: "算總和" };

function codeOutcome(): AgentChatOutcome {
  return {
    status: "code",
    text: "",
    code: CODE,
    toolUseId: "toolu_code_1",
    appended: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_code_1", name: "core.code.run", input: CODE },
        ],
      },
    ],
    steps: 1,
    toolCalls: [],
  };
}

describe("沙盒卡的存取", () => {
  it("待執行的沙盒卡跟著回來,而且那一個懸空是合法的", () => {
    const state = applyChatOutcome(appendUserMessage(emptyTranscript(), "總和?"), codeOutcome());
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored).toEqual(state);
    expect(restored?.pendingCode).toEqual({ code: CODE, toolUseId: "toolu_code_1" });
    expect(findDanglingToolUseIds(restored!.messages)).toEqual(["toolu_code_1"]);
    expect(canSend(restored!)).toBe(false);
  });

  it("跑完之後的 state 也回得來(含 result 這種任意 JSON 值),而且可以繼續送", () => {
    const state = applyCodeResolution(
      applyChatOutcome(appendUserMessage(emptyTranscript(), "總和?"), codeOutcome()),
      { kind: "ran", run: { ok: true, logs: ["adding"], resultJson: '{"sum":6}' } },
    );
    const restored = deserializeTranscript(serializeTranscript(state) as string);
    expect(restored).toEqual(state);
    expect(canSend(restored!)).toBe(true);
    const card = restored!.entries.find((e) => e.kind === "code");
    expect(card).toMatchObject({
      resolution: "ran",
      output: { ok: true, result: { sum: 6 }, logs: ["adding"] },
    });
  });

  it("pendingCode 指向一個已經有結果的 tool_use → 整包丟掉", () => {
    const payload = payloadOf(conversation(1));
    expect(
      restoreFrom({
        ...payload,
        state: { ...payload.state, pendingCode: { code: CODE, toolUseId: "toolu_read_0" } },
      }),
    ).toBeNull();
  });

  it("與另一張卡同時待處理 → 整包丟掉(loop 一輪最多攔一個 tool_use)", () => {
    const payload = payloadOf(
      applyChatOutcome(appendUserMessage(emptyTranscript(), "改"), proposalOutcome()),
    );
    expect(
      restoreFrom({
        ...payload,
        state: {
          ...payload.state,
          pendingCode: { code: CODE, toolUseId: PROPOSAL.toolUseId },
        },
      }),
    ).toBeNull();
  });

  it("存進來的程式碼超過 8,000 字上限 → 整包丟掉(還原出的卡會顯示模型沒送過的東西)", () => {
    const payload = payloadOf(
      applyChatOutcome(appendUserMessage(emptyTranscript(), "總和?"), codeOutcome()),
    );
    const entries = payload.state.entries.map((entry) =>
      entry.kind === "code" ? { ...entry, code: { code: "x".repeat(9_000) } } : entry,
    );
    expect(restoreFrom({ ...payload, state: { ...payload.state, entries } })).toBeNull();
  });

  it("§4.7 之前寫下的 payload(沒有 pendingCode 這個鍵)仍然讀得回來", () => {
    // 「鍵不存在」與「鍵是 null」本來就同義。為了一個純追加的欄位把所有人手上的
    // 對話丟掉,代價與收穫不成比例(persist.ts 的 stateSchema 有完整說明)。
    const payload = payloadOf(conversation(2));
    const legacyState: Partial<TranscriptState> = { ...payload.state };
    delete legacyState.pendingCode;
    const restored = restoreFrom({ ...payload, state: legacyState });
    expect(restored).not.toBeNull();
    expect(restored?.pendingCode).toBeNull();
    expect(canSend(restored!)).toBe(true);
  });
});
