import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ai:generate v1.2 tool calling(docs/spec-admin-agent.md §3)的單元測試:
// settings / fetch / Workers AI binding 皆替身,與 test/ai-provider.test.ts 同一套
// mocking 手法 —— 只靜態 import provider 葉模組 + mock 掉它直接呼叫的兩個葉模組
// (@/lib/settings、@/lib/cf)。
//
// 檔案末段另測 src/lib/ai.ts 的 chatAiWithTools helper,那裡 mock 的是
// @/ext/loader + @/ext/services(同 test/placeholder-email.test.ts 的既有慣例),
// 避開 loader → interpret.tsx → next/navigation 這條 workers pool 地雷。

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
vi.mock("@/lib/cf", () => ({
  getAI: () => cfState.ai,
}));

// chatAiWithTools 的 provider 替身:預設不實作 chat(驗「缺方法 → 退
// tool_use_not_supported」),個別測試再換成有 chat 的。
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

import { CoreAiProvider, toAssistantMessage } from "../src/ext/providers/ai";
import type {
  AiChatMessage,
  AiChatOptions,
  AiToolDef,
} from "../src/ext/providers/ai";
import { chatAiWithTools } from "../src/lib/ai";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

/** 一輪完整的 tool round-trip transcript:助理要求呼叫 → 結果接回。 */
const ROUND_TRIP: AiChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "list posts" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "let me check" },
      {
        type: "tool_use",
        id: "call_1",
        name: "core.content.list",
        input: { type: "post" },
      },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", toolUseId: "call_1", content: '{"items":[]}' },
      { type: "text", text: "anything else?" },
    ],
  },
];

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("CoreAiProvider.chat", () => {
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

  // ---- 1. not_configured(與 generate() 同一組前置檢查) ----

  it("mode off (default) → not_configured, no fetch", async () => {
    expect(await provider.chat(ASK)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing model → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "openai",
      "core.ai.apiKey": "sk-x",
    };
    expect(await provider.chat(ASK)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown mode value → not_configured, never a throw", async () => {
    settingsState.values = {
      "core.ai.mode": "gemini-typo",
      "core.ai.model": "x",
    };
    expect(await provider.chat(ASK)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("openai mode missing apiKey → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "openai",
      "core.ai.model": "gpt-4o-mini",
    };
    expect(await provider.chat(ASK)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anthropic mode missing apiKey → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "anthropic",
      "core.ai.model": "claude-haiku-4-5-20251001",
    };
    expect(await provider.chat(ASK)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- 2. openai:function calling wire format ----

  describe("openai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.model": "gpt-4o-mini",
        "core.ai.apiKey": "sk-secret",
      };
    });

    it("sends tools as functions and system as a leading system message", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        }),
      );
      await provider.chat({ ...ASK, system: "you are the admin assistant" });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk-secret",
      );
      const body = bodyOf(fetchMock);
      expect(body.messages).toEqual([
        { role: "system", content: "you are the admin assistant" },
        { role: "user", content: "list posts" },
      ]);
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "core.content.list",
            description: "List content items",
            parameters: TOOLS[0].inputSchema,
          },
        },
      ]);
      expect(body.max_tokens).toBe(1024);
      // stream 是 v1.1 的東西,chat v1 非 streaming(spec §3)。
      expect(body.stream).toBeUndefined();
    });

    it("omits tools entirely when the tool list is empty", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        }),
      );
      await provider.chat({ ...ASK, tools: [] });
      expect(bodyOf(fetchMock).tools).toBeUndefined();
    });

    it("maps tool_use → tool_calls and tool_result → a role:'tool' message before the user text", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        }),
      );
      await provider.chat({ messages: ROUND_TRIP, tools: TOOLS });

      expect(bodyOf(fetchMock).messages).toEqual([
        { role: "user", content: "list posts" },
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "core.content.list",
                arguments: JSON.stringify({ type: "post" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"items":[]}' },
        { role: "user", content: "anything else?" },
      ]);
    });

    it("parses tool_calls into toolUses with JSON-parsed input and stopReason tool_use", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_9",
                    type: "function",
                    function: {
                      name: "core.content.list",
                      arguments: '{"type":"post"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
      expect(await provider.chat(ASK)).toEqual({
        ok: true,
        text: "",
        toolUses: [
          { id: "call_9", name: "core.content.list", input: { type: "post" } },
        ],
        stopReason: "tool_use",
        model: "gpt-4o-mini",
      });
    });

    it("treats an empty arguments string as {} and keeps unparsable arguments as the raw string", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "a",
                    type: "function",
                    function: { name: "t", arguments: "" },
                  },
                  {
                    id: "b",
                    type: "function",
                    function: { name: "t", arguments: "{not json" },
                  },
                ],
              },
              // 代理常在帶 tool_calls 時仍回 "stop";以實際有無 tool_use 為準。
              finish_reason: "stop",
            },
          ],
        }),
      );
      const res = await provider.chat(ASK);
      expect(res.toolUses).toEqual([
        { id: "a", name: "t", input: {} },
        { id: "b", name: "t", input: "{not json" },
      ]);
      expect(res.stopReason).toBe("tool_use");
    });

    it("maps finish_reason length → max_tokens and stop → end_turn", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "cut" }, finish_reason: "length" }],
        }),
      );
      expect((await provider.chat(ASK)).stopReason).toBe("max_tokens");

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        }),
      );
      const res = await provider.chat(ASK);
      expect(res).toEqual({
        ok: true,
        text: "done",
        toolUses: [],
        stopReason: "end_turn",
        model: "gpt-4o-mini",
      });
    });

    it("uses a custom baseUrl when core.ai.baseUrl is set", async () => {
      settingsState.values["core.ai.baseUrl"] = "https://proxy.example.com/v1";
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        }),
      );
      await provider.chat(ASK);
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
        "https://proxy.example.com/v1/chat/completions",
      );
    });

    it("non-2xx → error summary that never leaks the apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(429, { error: { message: "rate limited" } }),
      );
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("429");
      expect(res.error).toContain("rate limited");
      expect(res.error).not.toContain("sk-secret");
    });

    it("unexpected response shape → error, not a throw", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { nope: true }));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("unexpected response shape");
    });

    it("aborted request → { ok:false, error:'timeout' }", async () => {
      fetchMock.mockImplementationOnce(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      });
      expect(await provider.chat(ASK)).toEqual({ ok: false, error: "timeout" });
    });

    it("network failure → summary result, not a throw, and no apiKey in it", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("network_error");
      expect(res.error).not.toContain("sk-secret");
    });

    it("caps maxTokens at 8192", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        }),
      );
      await provider.chat({ ...ASK, maxTokens: 999_999 });
      expect(bodyOf(fetchMock).max_tokens).toBe(8192);
    });
  });

  // ---- 3. anthropic:原生 tool use ----

  describe("anthropic mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "anthropic",
        "core.ai.model": "claude-haiku-4-5-20251001",
        "core.ai.apiKey": "sk-ant-secret",
      };
    });

    it("sends tools with input_schema, system at the top level, and content blocks 1:1", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
      );
      await provider.chat({
        messages: ROUND_TRIP,
        tools: TOOLS,
        system: "you are the admin assistant",
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-secret");
      expect(headers["anthropic-version"]).toBe("2023-06-01");

      const body = bodyOf(fetchMock);
      expect(body.system).toBe("you are the admin assistant");
      expect(body.tools).toEqual([
        {
          name: "core.content.list",
          description: "List content items",
          input_schema: TOOLS[0].inputSchema,
        },
      ]);
      expect(body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "list posts" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_use",
              id: "call_1",
              name: "core.content.list",
              input: { type: "post" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: '{"items":[]}',
            },
            { type: "text", text: "anything else?" },
          ],
        },
      ]);
    });

    it("marks failed tool results with is_error", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { content: [], stop_reason: "end_turn" }),
      );
      await provider.chat({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_1",
                content: "boom",
                isError: true,
              },
            ],
          },
        ],
        tools: TOOLS,
      });
      expect(bodyOf(fetchMock).messages[0].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call_1",
        content: "boom",
        is_error: true,
      });
    });

    it("parses tool_use blocks and joins text blocks", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          content: [
            { type: "text", text: "let me " },
            { type: "text", text: "check" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "core.content.list",
              input: { type: "post" },
            },
          ],
          stop_reason: "tool_use",
        }),
      );
      expect(await provider.chat(ASK)).toEqual({
        ok: true,
        text: "let me check",
        toolUses: [
          { id: "toolu_1", name: "core.content.list", input: { type: "post" } },
        ],
        stopReason: "tool_use",
        model: "claude-haiku-4-5-20251001",
      });
    });

    it("maps stop_reason max_tokens and end_turn", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          content: [{ type: "text", text: "cut" }],
          stop_reason: "max_tokens",
        }),
      );
      expect((await provider.chat(ASK)).stopReason).toBe("max_tokens");

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        }),
      );
      expect((await provider.chat(ASK)).stopReason).toBe("end_turn");
    });

    it("non-2xx → error summary that never leaks the apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: { message: "invalid x-api-key" } }),
      );
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("401");
      expect(res.error).not.toContain("sk-ant-secret");
    });

    it("unexpected response shape → error, not a throw", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { nope: true }));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("unexpected response shape");
    });

    it("aborted request → { ok:false, error:'timeout' }", async () => {
      fetchMock.mockImplementationOnce(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      });
      expect(await provider.chat(ASK)).toEqual({ ok: false, error: "timeout" });
    });
  });

  // ---- 4. workers-ai:僅部分模型支援(spec §3) ----

  describe("workers-ai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "workers-ai",
        "core.ai.model": "@cf/meta/llama-3.1-8b-instruct",
      };
    });

    it("missing AI binding → not_configured (not tool_use_not_supported), never calls fetch", async () => {
      cfState.ai = undefined;
      expect(await provider.chat(ASK)).toEqual({
        ok: false,
        error: "not_configured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("binding rejection → tool_use_not_supported (spec §3: no model allowlist, just try)", async () => {
      cfState.ai = {
        run: vi.fn().mockRejectedValue(new Error("No such tool support")),
      };
      expect(await provider.chat(ASK)).toEqual({
        ok: false,
        error: "tool_use_not_supported",
      });
    });

    it("unrecognisable response shape → tool_use_not_supported", async () => {
      cfState.ai = { run: vi.fn(async () => ({ nope: true })) };
      expect(await provider.chat(ASK)).toEqual({
        ok: false,
        error: "tool_use_not_supported",
      });
    });

    it("timeout stays 'timeout' — a slow network is not an unsupported model", async () => {
      // withTimeout 用相對毫秒;假造 setTimeout 太脆,改讓 binding 直接以
      // Error("timeout") reject —— 那正是 withTimeout 逾時時的 reject 值。
      cfState.ai = { run: vi.fn().mockRejectedValue(new Error("timeout")) };
      expect(await provider.chat(ASK)).toEqual({ ok: false, error: "timeout" });
    });

    it("passes tools as parameters-shaped defs and flattens the transcript", async () => {
      const run = vi.fn(async () => ({ response: "done" }));
      cfState.ai = { run };
      await provider.chat({
        messages: ROUND_TRIP,
        tools: TOOLS,
        system: "be careful",
      });
      expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          { role: "system", content: "be careful" },
          { role: "user", content: "list posts" },
          {
            role: "assistant",
            content: "let me check",
            tool_calls: [
              { name: "core.content.list", arguments: { type: "post" } },
            ],
          },
          // tool 結果訊息帶 name(workers-ai 的 tool_calls 沒有 id,只能靠名字對回),
          // 名字由 transcript 裡的 tool_use 反查。
          {
            role: "tool",
            content: '{"items":[]}',
            name: "core.content.list",
          },
          { role: "user", content: "anything else?" },
        ],
        max_tokens: 1024,
        tools: [
          {
            name: "core.content.list",
            description: "List content items",
            parameters: TOOLS[0].inputSchema,
          },
        ],
      });
    });

    it("tool_calls in the response become toolUses with a synthesized id", async () => {
      cfState.ai = {
        run: vi.fn(async () => ({
          response: "",
          tool_calls: [
            { name: "core.content.list", arguments: { type: "post" } },
          ],
        })),
      };
      expect(await provider.chat(ASK)).toEqual({
        ok: true,
        text: "",
        toolUses: [
          {
            id: "wai_0_core.content.list",
            name: "core.content.list",
            input: { type: "post" },
          },
        ],
        stopReason: "tool_use",
        model: "@cf/meta/llama-3.1-8b-instruct",
      });
    });

    it("a plain text answer is a valid turn, not an unsupported model", async () => {
      cfState.ai = { run: vi.fn(async () => ({ response: "just text" })) };
      expect(await provider.chat(ASK)).toEqual({
        ok: true,
        text: "just text",
        toolUses: [],
        stopReason: "end_turn",
        model: "@cf/meta/llama-3.1-8b-instruct",
      });
    });
  });
});

// ---- 5. toAssistantMessage:loop 把這一輪接回 transcript 的還原規則 ----

describe("toAssistantMessage", () => {
  it("puts text first, then each tool_use in order", () => {
    expect(
      toAssistantMessage({
        ok: true,
        text: "checking",
        toolUses: [{ id: "c1", name: "t", input: { a: 1 } }],
        stopReason: "tool_use",
      }),
    ).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "c1", name: "t", input: { a: 1 } },
      ],
    });
  });

  it("omits the text block when the turn was tool calls only", () => {
    expect(
      toAssistantMessage({
        ok: true,
        text: "",
        toolUses: [{ id: "c1", name: "t", input: {} }],
        stopReason: "tool_use",
      }).content,
    ).toEqual([{ type: "tool_use", id: "c1", name: "t", input: {} }]);
  });
});

// ---- 6. src/lib/ai.ts helper ----

describe("chatAiWithTools", () => {
  it("returns tool_use_not_supported when the active provider has no chat method", async () => {
    providerState.provider = { generate: async () => ({ ok: true }) };
    expect(await chatAiWithTools(ASK)).toEqual({
      ok: false,
      error: "tool_use_not_supported",
    });
  });

  it("delegates to the active provider's chat when it exists", async () => {
    const chat = vi.fn(async () => ({
      ok: true,
      text: "hi",
      toolUses: [],
      stopReason: "end_turn" as const,
    }));
    providerState.provider = { generate: async () => ({ ok: true }), chat };
    expect(await chatAiWithTools(ASK)).toEqual({
      ok: true,
      text: "hi",
      toolUses: [],
      stopReason: "end_turn",
    });
    expect(chat).toHaveBeenCalledWith(ASK);
  });
});
