import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ai:generate v1.2.1 —— tool-calling streaming(CORE_API 1.32.0,
// docs/spec-admin-agent.md §3.1)的單元測試。
//
// mocking 手法與 test/ai-chat.test.ts 完全相同(settings / fetch / AI binding 皆
// 替身,只靜態 import provider 葉模組)。SSE body 是**手打的 wire 文字**經真的
// Response 轉成真的 ReadableStream —— 測的是本專案自己寫的解析,不是走捷徑假造
// 事件(沿 test/ai-provider.test.ts 的既有慣例)。
//
// 這一檔最重要的一組斷言不是「串流有沒有動」,而是**一致性**:同一個上游回應,
// 一次以串流形式送、一次以整包 JSON 送,chat() 與 chatStream() 最後算出的
// AiChatResult 必須完全相等。前端的 transcript 是由 result 組裝的,兩條路分岔的
// 後果是「畫面上看到的」與「送回上游續談的」不是同一段對話。

const settingsState = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback?: unknown) =>
    settingsState.values[key] ?? fallback,
}));

interface FakeAiBinding {
  run: (model: string, input: unknown) => Promise<unknown>;
}
const cfState = vi.hoisted(() => ({
  ai: undefined as FakeAiBinding | undefined,
}));
vi.mock("@/lib/cf", () => ({ getAI: () => cfState.ai }));

// chatAiStreamWithTools 的 provider 替身(檔尾那一組測試用)。
const providerState = vi.hoisted(() => ({
  provider: {} as Record<string, unknown>,
}));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({}) }));
vi.mock("@/ext/services", () => ({
  buildProviderRegistry: () => ({
    resolveActive: async () => {},
    get: () => providerState.provider,
  }),
}));

import { CoreAiProvider } from "../src/ext/providers/ai";
import type {
  AiChatOptions,
  AiChatResult,
  AiChatStreamEvent,
  AiToolDef,
} from "../src/ext/providers/ai";
import { chatAiStreamWithTools } from "../src/lib/ai";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 手打的 SSE 文字 → 真的 Response(res.body 是真的 ReadableStream)。 */
function sseResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 逐塊送出的 SSE：切點由測試指定,用來證明 frame 邊界不依賴 chunk 邊界。 */
function chunkedSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 先送一塊、下一次讀取才壞掉 —— 「讀到一半斷線」的真實形狀。
 *  用 pull 而不是在 start 裡 enqueue 完就 error:後者會讓已排隊的 chunk 一起被
 *  丟掉,測到的就變成「一個字都沒收到」,而不是「收到一半才斷」。 */
function brokenSseResponse(prefix: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(prefix));
        return;
      }
      controller.error(new Error("socket hang up"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(
  gen: AsyncGenerator<AiChatStreamEvent>,
): Promise<AiChatStreamEvent[]> {
  const out: AiChatStreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

/** 最後一個事件必須是 result(型別契約),回傳它的 result。 */
function lastResult(events: readonly AiChatStreamEvent[]): AiChatResult {
  expect(events.length).toBeGreaterThan(0);
  const last = events[events.length - 1]!;
  expect(last.type).toBe("result");
  // result 只能有一個,而且只能在最後。
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  if (last.type !== "result") throw new Error("unreachable");
  return last.result;
}

function deltas(events: readonly AiChatStreamEvent[]): string[] {
  return events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

const TOOLS: AiToolDef[] = [
  {
    name: "core.content.list",
    description: "List content items",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string" } },
      required: ["type"],
    },
  },
];

const ASK: AiChatOptions = {
  messages: [{ role: "user", content: [{ type: "text", text: "list posts" }] }],
  tools: TOOLS,
};

describe("CoreAiProvider.chatStream", () => {
  const provider = new CoreAiProvider();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settingsState.values = {};
    cfState.ai = undefined;
    fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- 1. 前置檢查:與 chat() 同一組 ----

  it("mode off (default) → 單一 result not_configured, no fetch", async () => {
    const events = await collect(provider.chatStream(ASK));
    expect(events).toEqual([
      { type: "result", result: { ok: false, error: "not_configured" } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown mode value → not_configured,永不 throw", async () => {
    settingsState.values = { "core.ai.mode": "gemini-typo", "core.ai.model": "x" };
    expect(lastResult(await collect(provider.chatStream(ASK)))).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("openai 缺 apiKey → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "openai",
      "core.ai.model": "gpt-4o-mini",
    };
    expect(lastResult(await collect(provider.chatStream(ASK)))).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- 2. openai ----

  describe("openai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.model": "gpt-4o-mini",
        "core.ai.apiKey": "sk-secret",
      };
    });

    const TEXT_SSE =
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"world"}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    it("多塊文字逐塊 yield,收尾 result 帶全文與 stopReason", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(TEXT_SSE));
      const events = await collect(provider.chatStream(ASK));

      expect(deltas(events)).toEqual(["Hel", "lo, ", "world"]);
      expect(lastResult(events)).toEqual({
        ok: true,
        text: "Hello, world",
        toolUses: [],
        stopReason: "end_turn",
        model: "gpt-4o-mini",
      });
      // 送出去的 body 與 chat() 同一份,只多了 stream:true。
      const body = bodyOf(fetchMock);
      expect(body.stream).toBe(true);
      expect(body.messages).toEqual([{ role: "user", content: "list posts" }]);
      expect(body.tools[0].function.name).toBe("core-content-list");
    });

    it("tool_call 的 arguments 跨塊串接,id/name 只在首塊", async () => {
      const sse =
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"core-content-list","arguments":""}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"type\\":"}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"post\\"}"}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
        `data: [DONE]\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));

      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events)).toEqual([]);
      expect(lastResult(events)).toEqual({
        ok: true,
        text: "",
        toolUses: [
          // wire 名(core-content-list)已還原成點分正名 —— 回程有查表。
          { id: "call_9", name: "core.content.list", input: { type: "post" } },
        ],
        stopReason: "tool_use",
        model: "gpt-4o-mini",
      });
    });

    it("兩個 tool call 以 index 聚合,亂序抵達也對得回去", async () => {
      const sse =
        `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"core-content-list","arguments":"{\\"type\\":\\"page\\"}"}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"core-content-list","arguments":"{\\"type\\":\\"post\\"}"}}]}}]}\n\n` +
        `data: [DONE]\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));

      const result = lastResult(await collect(provider.chatStream(ASK)));
      // 依 index 排序,不是依抵達順序 —— tool_result 要對回同一個順序。
      expect(result.toolUses?.map((u) => u.id)).toEqual(["call_a", "call_b"]);
    });

    it("frame 被切在任意位置也不掉字(buffer 邊界)", async () => {
      // 每 7 個字元切一刀:frame 邊界必然落在 chunk 中間。
      const chunks: string[] = [];
      for (let i = 0; i < TEXT_SSE.length; i += 7) {
        chunks.push(TEXT_SSE.slice(i, i + 7));
      }
      fetchMock.mockResolvedValueOnce(chunkedSseResponse(chunks));

      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events).join("")).toBe("Hello, world");
      expect(lastResult(events).text).toBe("Hello, world");
    });

    it("上游 4xx → 單一 result ok:false,不 throw,不含 apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: { message: "Incorrect API key sk-secret" } }),
      );
      const events = await collect(provider.chatStream(ASK));
      expect(events).toHaveLength(1);
      const result = lastResult(events);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("openai 401");
      // 訊息本身是上游回的,本專案不另外拼入設定裡的 key。
      expect(result.error).not.toContain("Bearer");
    });

    it("讀到一半斷線 → 已 yield 的 delta 保留,收尾是 ok:false", async () => {
      fetchMock.mockResolvedValueOnce(
        brokenSseResponse(`data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`),
      );
      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events)).toEqual(["partial"]);
      const result = lastResult(events);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("openai network_error");
    });

    it("連上了但一個可用 frame 都沒有 → ok:false,不是空的 ok:true", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(""));
      const result = lastResult(await collect(provider.chatStream(ASK)));
      expect(result).toEqual({ ok: false, error: "openai: empty stream" });
    });

    it("串流與非串流對同一個回應算出完全相同的 AiChatResult", async () => {
      const streamed =
        `data: {"choices":[{"delta":{"content":"let me check"}}]}\n\n` +
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"core-content-list","arguments":"{\\"type\\":"}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"post\\"}"}}]}}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
        `data: [DONE]\n\n`;
      const whole = {
        choices: [
          {
            message: {
              content: "let me check",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "core-content-list",
                    arguments: '{"type":"post"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };

      fetchMock.mockResolvedValueOnce(sseResponse(streamed));
      const fromStream = lastResult(await collect(provider.chatStream(ASK)));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, whole));
      const fromChat = await provider.chat(ASK);

      expect(fromStream).toEqual(fromChat);
    });
  });

  // ---- 3. anthropic ----

  describe("anthropic mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "anthropic",
        "core.ai.model": "claude-haiku-4-5-20251001",
        "core.ai.apiKey": "sk-ant-secret",
      };
    });

    const TEXT_SSE =
      `event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

    it("文字逐塊 yield,message_delta 的 stop_reason 進 result", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(TEXT_SSE));
      const events = await collect(
        provider.chatStream({ ...ASK, system: "be nice" }),
      );

      expect(deltas(events)).toEqual(["Hello", " there"]);
      expect(lastResult(events)).toEqual({
        ok: true,
        text: "Hello there",
        toolUses: [],
        stopReason: "end_turn",
        model: "claude-haiku-4-5-20251001",
      });
      const body = bodyOf(fetchMock);
      expect(body.stream).toBe(true);
      expect(body.system).toBe("be nice");
      expect(body.tools[0].name).toBe("core-content-list");
    });

    it("input_json_delta 跨塊串接成 tool_use 的 input", async () => {
      const sse =
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"checking"}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"core-content-list","input":{}}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"post\\"}"}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));

      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events)).toEqual(["checking"]);
      expect(lastResult(events)).toEqual({
        ok: true,
        text: "checking",
        toolUses: [
          { id: "toolu_1", name: "core.content.list", input: { type: "post" } },
        ],
        stopReason: "tool_use",
        model: "claude-haiku-4-5-20251001",
      });
    });

    it("沒有 input_json_delta 的 tool_use → input 是 {}(同非串流的 `input ?? {}`)", async () => {
      const sse =
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"core-content-list","input":{}}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));
      expect(lastResult(await collect(provider.chatStream(ASK))).toolUses).toEqual([
        { id: "toolu_2", name: "core.content.list", input: {} },
      ]);
    });

    it("文字塊依 index 串接,不依抵達順序", async () => {
      const sse =
        `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"second"}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first "}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));
      expect(lastResult(await collect(provider.chatStream(ASK))).text).toBe(
        "first second",
      );
    });

    it("frame 被切在任意位置也不掉字", async () => {
      const chunks: string[] = [];
      for (let i = 0; i < TEXT_SSE.length; i += 11) {
        chunks.push(TEXT_SSE.slice(i, i + 11));
      }
      fetchMock.mockResolvedValueOnce(chunkedSseResponse(chunks));
      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events).join("")).toBe("Hello there");
      expect(lastResult(events).text).toBe("Hello there");
    });

    it("event: error 中途 → 收尾 result ok:false", async () => {
      const sse =
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n` +
        `event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n`;
      fetchMock.mockResolvedValueOnce(sseResponse(sse));
      const events = await collect(provider.chatStream(ASK));
      expect(deltas(events)).toEqual(["partial"]);
      expect(lastResult(events)).toEqual({
        ok: false,
        error: "anthropic: overloaded",
      });
    });

    it("上游 4xx → 單一 result ok:false,不含 apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: { message: "invalid x-api-key" } }),
      );
      const events = await collect(provider.chatStream(ASK));
      expect(events).toHaveLength(1);
      const result = lastResult(events);
      expect(result.error).toContain("401");
      expect(result.error).not.toContain("sk-ant-secret");
    });

    it("讀到一半斷線 → ok:false,不 throw", async () => {
      fetchMock.mockResolvedValueOnce(
        brokenSseResponse(
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        ),
      );
      const result = lastResult(await collect(provider.chatStream(ASK)));
      expect(result.ok).toBe(false);
      expect(result.error).toContain("anthropic network_error");
    });

    it("完全空的串流 → ok:false", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(""));
      expect(lastResult(await collect(provider.chatStream(ASK)))).toEqual({
        ok: false,
        error: "anthropic: empty stream",
      });
    });

    it("串流與非串流對同一個回應算出完全相同的 AiChatResult", async () => {
      const streamed =
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"let me check"}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"core-content-list","input":{}}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"post\\"}"}}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      const whole = {
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "core-content-list",
            input: { type: "post" },
          },
        ],
        stop_reason: "tool_use",
      };

      fetchMock.mockResolvedValueOnce(sseResponse(streamed));
      const fromStream = lastResult(await collect(provider.chatStream(ASK)));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, whole));
      const fromChat = await provider.chat(ASK);

      expect(fromStream).toEqual(fromChat);
    });
  });

  // ---- 4. workers-ai:不實作串流,退回一次 chat() ----

  describe("workers-ai mode", () => {
    it("不串流:只有一個 result 事件,且與 chat() 的結果相同", async () => {
      settingsState.values = {
        "core.ai.mode": "workers-ai",
        "core.ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      };
      const run = vi.fn(async () => ({ response: "hi from workers ai" }));
      cfState.ai = { run };

      const events = await collect(provider.chatStream(ASK));
      expect(events).toHaveLength(1);
      expect(lastResult(events)).toEqual({
        ok: true,
        text: "hi from workers ai",
        toolUses: [],
        stopReason: "end_turn",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      });
      // 送出去的不是串流請求 —— 它走的就是非串流那一支。
      const input = run.mock.calls[0]![1] as Record<string, unknown>;
      expect(input.stream).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// src/lib/ai.ts 的 chatAiStreamWithTools
// ---------------------------------------------------------------------------

describe("chatAiStreamWithTools", () => {
  beforeEach(() => {
    providerState.provider = {};
  });

  it("provider 有 chatStream → 原樣轉發", async () => {
    providerState.provider = {
      chat: async () => ({ ok: true, text: "should not be used" }),
      chatStream: async function* (): AsyncGenerator<AiChatStreamEvent> {
        yield { type: "text_delta", text: "a" };
        yield { type: "result", result: { ok: true, text: "a", toolUses: [] } };
      },
    };
    expect(await collect(chatAiStreamWithTools(ASK))).toEqual([
      { type: "text_delta", text: "a" },
      { type: "result", result: { ok: true, text: "a", toolUses: [] } },
    ]);
  });

  it("provider 只有 chat → 包成單一 result 事件(呼叫端無感)", async () => {
    const chat = vi.fn(async () => ({ ok: true, text: "no streaming here" }));
    providerState.provider = { chat };
    const events = await collect(chatAiStreamWithTools(ASK));
    expect(events).toEqual([
      { type: "result", result: { ok: true, text: "no streaming here" } },
    ]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("兩者都沒有 → tool_use_not_supported(與 chatAiWithTools 同一個錯誤碼)", async () => {
    expect(await collect(chatAiStreamWithTools(ASK))).toEqual([
      { type: "result", result: { ok: false, error: "tool_use_not_supported" } },
    ]);
  });
});
