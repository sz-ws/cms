import { describe, expect, it } from "vitest";
import {
  COMPACT_AT_MESSAGES,
  COMPACT_HARD_MESSAGES,
  COMPACT_KEEP_MESSAGES,
  SUMMARY_HEADING,
  compactTranscript,
  pickCut,
  renderForSummary,
} from "../src/ext/agent-compact";
import type { AiChatMessage, AiChatOptions, AiChatResult } from "../src/ext/providers/ai";

const user = (text: string): AiChatMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): AiChatMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCall = (id: string): AiChatMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name: "core.settings.get", input: { keys: ["a"] } }] });
const toolResult = (id: string): AiChatMessage => ({ role: "user", content: [{ type: "tool_result", toolUseId: id, content: "[]" }] });

/** n 輪「問 → 查 → 結果 → 答」(每輪 4 則)。 */
function turns(n: number): AiChatMessage[] {
  return Array.from({ length: n }, (_, i) => [user(`question ${i}`), toolCall(`t${i}`), toolResult(`t${i}`), assistant(`answer ${i}`)]).flat();
}

const answering = (text: string) => {
  const calls: AiChatOptions[] = [];
  const chat = async (opts: AiChatOptions): Promise<AiChatResult> => {
    calls.push(opts);
    return { ok: true, text, toolUses: [], stopReason: "end_turn", model: "m", usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { chat, calls };
};

describe("compacting a long assistant conversation", () => {
  it("leaves a short conversation alone and calls nothing", async () => {
    const { chat, calls } = answering("summary");
    const messages = [...turns(3), user("next")];
    const result = await compactTranscript(messages, chat);
    expect(result).toEqual({ messages, compacted: false });
    expect(calls).toHaveLength(0);
  });

  it("cuts just before a message the administrator typed, keeping recent turns", () => {
    const messages = [...turns(12), user("next")];
    const cut = pickCut(messages)!;
    expect(messages[cut].content[0]).toMatchObject({ type: "text" });
    expect(messages[cut].role).toBe("user");
    expect(messages.length - cut).toBeLessThanOrEqual(COMPACT_KEEP_MESSAGES);
    expect(pickCut([user("only"), toolCall("a"), toolResult("a")])).toBeNull();
  });

  it("replaces the older part with a summary at the front of the first kept message", async () => {
    const { chat, calls } = answering("They changed the marquee text.");
    const messages = [...turns(12), user("next")];
    expect(messages.length).toBeGreaterThan(COMPACT_AT_MESSAGES);
    const result = await compactTranscript(messages, chat);
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(COMPACT_KEEP_MESSAGES);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content[0]).toEqual({ type: "text", text: `${SUMMARY_HEADING}\nThey changed the marquee text.` });
    expect(result.messages[result.messages.length - 1]).toEqual(user("next"));
    // 留下來的部分沒有落單的工具呼叫或結果。
    const uses = result.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])));
    const results = result.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : [])));
    expect(results).toEqual(uses);
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    expect(JSON.stringify(calls[0].messages)).toContain("question 0");
  });

  it("carries an earlier summary into the next one", async () => {
    const first = await compactTranscript([...turns(12), user("next")], answering("first summary").chat);
    const longer = [...first.messages, assistant("ok"), ...turns(12), user("again")];
    const { chat, calls } = answering("second summary");
    const second = await compactTranscript(longer, chat);
    expect(second.compacted).toBe(true);
    expect(JSON.stringify(calls[0].messages)).toContain("first summary");
  });

  it("keeps going unchanged when the summary fails, until the hard limit", async () => {
    const failing = async (): Promise<AiChatResult> => ({ ok: false, error: "timeout" });
    const messages = [...turns(12), user("next")];
    const soft = await compactTranscript(messages, failing);
    expect(soft.compacted).toBe(false);
    expect(soft.messages).toBe(messages);
    expect(soft.call?.ok).toBe(false);

    const long = [...turns(16), user("next")];
    expect(long.length).toBeGreaterThan(COMPACT_HARD_MESSAGES);
    const hard = await compactTranscript(long, async () => { throw new Error("boom"); });
    expect(hard.compacted).toBe(true);
    expect(hard.messages.length).toBeLessThanOrEqual(COMPACT_KEEP_MESSAGES);
    expect(JSON.stringify(hard.messages[0].content[0])).toContain("removed to keep it short");
  });

  it("clips long blocks in what the model is asked to summarise", () => {
    const text = renderForSummary([user("x".repeat(5000)), toolCall("a"), toolResult("a")]);
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("Assistant called core.settings.get");
  });
});
