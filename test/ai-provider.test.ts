import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// CoreAiProvider 單元測試:settings / fetch / Workers AI binding 皆替身。
// mirrors test/email-provider.test.ts 的 mocking 手法:只靜態 import provider 葉模組
// (../src/ext/providers/ai)+ mock 掉它直接呼叫的兩個葉模組(@/lib/settings、
// @/lib/cf),絕不碰 @/ext/loader / @/ext/services(workers pool 地雷)。

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

import { CoreAiProvider } from "../src/ext/providers/ai";
import type { AiStreamEvent } from "../src/ext/providers/ai";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// streaming 測試用:hand-built SSE 文字包成一個真的 Response,res.body 是真的
// ReadableStream<Uint8Array>——測 CoreAiProvider 自己手刻的 parseSseStream 對
// 「實際 wire format」的解析,不是走捷徑假造事件。
function sseResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// workers-ai 模式的 ai.run() 依 spec 直接回傳 ReadableStream(不是 Response),
// 用同一份 hand-built SSE 文字經 Response 轉出 body 即可取得一個真的
// ReadableStream<Uint8Array>。
function sseStream(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("test setup: Response has no body");
  return body;
}

async function collect(
  gen: AsyncGenerator<AiStreamEvent>,
): Promise<AiStreamEvent[]> {
  const out: AiStreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const MSG = { messages: [{ role: "user" as const, content: "hi" }] };

describe("CoreAiProvider", () => {
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

  // ---- 1. not_configured ----

  it("mode off (default) → not_configured, no fetch", async () => {
    const res = await provider.generate(MSG);
    expect(res).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing model → not_configured even with mode + apiKey set", async () => {
    settingsState.values = {
      "core.ai.mode": "openai",
      "core.ai.apiKey": "sk-x",
    };
    const res = await provider.generate(MSG);
    expect(res).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("openai mode missing apiKey → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "openai",
      "core.ai.model": "gpt-4o-mini",
    };
    const res = await provider.generate(MSG);
    expect(res).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anthropic mode missing apiKey → not_configured", async () => {
    settingsState.values = {
      "core.ai.mode": "anthropic",
      "core.ai.model": "claude-haiku-4-5-20251001",
    };
    const res = await provider.generate(MSG);
    expect(res).toEqual({ ok: false, error: "not_configured" });
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

    it("posts chat/completions with correct URL/headers/body and parses content", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { choices: [{ message: { content: "hello there" } }] }),
      );
      const res = await provider.generate({
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        temperature: 0.5,
      });
      expect(res).toEqual({ ok: true, text: "hello there", model: "gpt-4o-mini" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk-secret",
      );
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 1024,
        temperature: 0.5,
      });
    });

    it("uses a custom baseUrl when core.ai.baseUrl is set", async () => {
      settingsState.values["core.ai.baseUrl"] = "https://my-proxy.example.com/v1";
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { choices: [{ message: { content: "x" } }] }),
      );
      await provider.generate(MSG);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://my-proxy.example.com/v1/chat/completions");
    });

    it("non-2xx → error summary that never leaks the apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(429, { error: { message: "rate limited" } }),
      );
      const res = await provider.generate(MSG);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("429");
      expect(res.error).toContain("rate limited");
      expect(res.error).not.toContain("sk-secret");
    });

    it("aborted request → { ok:false, error:'timeout' }", async () => {
      fetchMock.mockImplementationOnce(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      });
      const res = await provider.generate(MSG);
      expect(res).toEqual({ ok: false, error: "timeout" });
    });

    it("network failure → provider_error-shaped summary, not a throw", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      const res = await provider.generate(MSG);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("network_error");
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

    it("extracts system messages into a top-level system string, sets headers, joins content[] text", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          content: [
            { type: "text", text: "hello " },
            { type: "tool_use", id: "x" },
            { type: "text", text: "there" },
          ],
        }),
      );
      const res = await provider.generate({
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
      });
      expect(res).toEqual({
        ok: true,
        text: "hello there",
        model: "claude-haiku-4-5-20251001",
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-secret");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(init.body as string);
      expect(body.system).toBe("be nice");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("joins multiple system messages with a blank line", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [] }));
      await provider.generate({
        messages: [
          { role: "system", content: "first" },
          { role: "system", content: "second" },
          { role: "user", content: "hi" },
        ],
      });
      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.system).toBe("first\n\nsecond");
    });

    it("non-2xx → error summary that never leaks the apiKey", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: { message: "invalid x-api-key" } }),
      );
      const res = await provider.generate(MSG);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("401");
      expect(res.error).not.toContain("sk-ant-secret");
    });
  });

  // ---- 4. workers-ai ----

  describe("workers-ai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "workers-ai",
        "core.ai.model": "@cf/meta/llama-3.1-8b-instruct",
      };
    });

    it("missing AI binding → not_configured, never calls fetch", async () => {
      cfState.ai = undefined;
      const res = await provider.generate(MSG);
      expect(res).toEqual({ ok: false, error: "not_configured" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("runs the binding and returns its response text", async () => {
      const run = vi.fn(async () => ({ response: "from workers ai" }));
      cfState.ai = { run };
      const res = await provider.generate(MSG);
      expect(res).toEqual({
        ok: true,
        text: "from workers ai",
        model: "@cf/meta/llama-3.1-8b-instruct",
      });
      expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.1-8b-instruct", {
        messages: MSG.messages,
        max_tokens: 1024,
      });
    });

    it("unexpected binding response shape → error, not a throw", async () => {
      cfState.ai = { run: vi.fn(async () => ({ nope: true })) };
      const res = await provider.generate(MSG);
      expect(res.ok).toBe(false);
    });

    it("binding rejection is mapped to a result, not a throw", async () => {
      const run = vi.fn().mockRejectedValue(new Error("boom"));
      cfState.ai = { run };
      const res = await provider.generate(MSG);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("boom");
    });
  });

  // ---- 5. maxTokens default / cap ----

  describe("maxTokens", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.model": "gpt-4o-mini",
        "core.ai.apiKey": "sk-secret",
      };
      fetchMock.mockResolvedValue(
        jsonResponse(200, { choices: [{ message: { content: "x" } }] }),
      );
    });

    it("defaults to 1024 when omitted", async () => {
      await provider.generate(MSG);
      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.max_tokens).toBe(1024);
    });

    it("caps at 8192 even when a larger value is requested", async () => {
      await provider.generate({ ...MSG, maxTokens: 999_999 });
      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.max_tokens).toBe(8192);
    });

    it("passes through a value under the cap unchanged", async () => {
      await provider.generate({ ...MSG, maxTokens: 256 });
      const body = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.max_tokens).toBe(256);
    });
  });

  // ---- 6. generateStream (v1.1 streaming, docs/spec-ai-capability.md streaming 附錄) ----

  describe("generateStream", () => {
    it("mode off (default) → single not_configured error event, no fetch", async () => {
      const events = await collect(provider.generateStream(MSG));
      expect(events).toEqual([{ type: "error", error: "not_configured" }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("missing model → single not_configured error event", async () => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.apiKey": "sk-x",
      };
      const events = await collect(provider.generateStream(MSG));
      expect(events).toEqual([{ type: "error", error: "not_configured" }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("openai mode", () => {
      beforeEach(() => {
        settingsState.values = {
          "core.ai.mode": "openai",
          "core.ai.model": "gpt-4o-mini",
          "core.ai.apiKey": "sk-secret",
        };
      });

      it("missing apiKey → single not_configured error event", async () => {
        settingsState.values = {
          "core.ai.mode": "openai",
          "core.ai.model": "gpt-4o-mini",
        };
        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([{ type: "error", error: "not_configured" }]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("yields delta events for each content chunk then done, and sends stream:true", async () => {
        const sse =
          `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
          `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n` +
          `data: {"choices":[{"delta":{"content":" there"}}]}\n\n` +
          `data: [DONE]\n\n`;
        fetchMock.mockResolvedValueOnce(sseResponse(200, sse));

        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([
          { type: "delta", text: "Hello" },
          { type: "delta", text: " there" },
          { type: "done", model: "gpt-4o-mini" },
        ]);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.openai.com/v1/chat/completions");
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
      });

      it("non-2xx → single error event with truncated upstream summary, never leaking the apiKey", async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse(429, { error: { message: "rate limited" } }),
        );
        const events = await collect(provider.generateStream(MSG));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("error");
        const err = events[0] as { type: "error"; error: string };
        expect(err.error).toContain("429");
        expect(err.error).toContain("rate limited");
        expect(err.error).not.toContain("sk-secret");
      });

      it("aborted request → single { type:'error', error:'timeout' } event", async () => {
        fetchMock.mockImplementationOnce(() => {
          const err = new Error("aborted");
          err.name = "AbortError";
          return Promise.reject(err);
        });
        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([{ type: "error", error: "timeout" }]);
      });
    });

    describe("anthropic mode", () => {
      beforeEach(() => {
        settingsState.values = {
          "core.ai.mode": "anthropic",
          "core.ai.model": "claude-haiku-4-5-20251001",
          "core.ai.apiKey": "sk-ant-secret",
        };
      });

      it("yields delta events for text_delta chunks then done on message_stop, and sends stream:true", async () => {
        const sse =
          `event: content_block_delta\n` +
          `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n` +
          `event: content_block_delta\n` +
          `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n` +
          `event: message_stop\n` +
          `data: {"type":"message_stop"}\n\n`;
        fetchMock.mockResolvedValueOnce(sseResponse(200, sse));

        const events = await collect(
          provider.generateStream({
            messages: [
              { role: "system", content: "be nice" },
              { role: "user", content: "hi" },
            ],
          }),
        );
        expect(events).toEqual([
          { type: "delta", text: "Hello" },
          { type: "delta", text: " there" },
          { type: "done", model: "claude-haiku-4-5-20251001" },
        ]);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        expect(body.system).toBe("be nice");
      });

      it("event: error frame mid-stream → single error event", async () => {
        const sse =
          `event: content_block_delta\n` +
          `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n` +
          `event: error\n` +
          `data: {"type":"error","error":{"message":"overloaded"}}\n\n`;
        fetchMock.mockResolvedValueOnce(sseResponse(200, sse));

        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([
          { type: "delta", text: "partial" },
          { type: "error", error: "anthropic: overloaded" },
        ]);
      });

      it("non-2xx → single error event, never leaking the apiKey", async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse(401, { error: { message: "invalid x-api-key" } }),
        );
        const events = await collect(provider.generateStream(MSG));
        expect(events).toHaveLength(1);
        const err = events[0] as { type: "error"; error: string };
        expect(err.error).toContain("401");
        expect(err.error).not.toContain("sk-ant-secret");
      });

      it("aborted request → single { type:'error', error:'timeout' } event", async () => {
        fetchMock.mockImplementationOnce(() => {
          const err = new Error("aborted");
          err.name = "AbortError";
          return Promise.reject(err);
        });
        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([{ type: "error", error: "timeout" }]);
      });
    });

    describe("workers-ai mode", () => {
      beforeEach(() => {
        settingsState.values = {
          "core.ai.mode": "workers-ai",
          "core.ai.model": "@cf/meta/llama-3.1-8b-instruct",
        };
      });

      it("missing AI binding → single not_configured error event, never calls fetch", async () => {
        cfState.ai = undefined;
        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([{ type: "error", error: "not_configured" }]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("yields delta events parsed from the binding's SSE-framed ReadableStream, then done", async () => {
        const sse =
          `data: {"response":"Hello"}\n\n` +
          `data: {"response":" there"}\n\n` +
          `data: [DONE]\n\n`;
        const run = vi.fn(async () => sseStream(sse));
        cfState.ai = { run };

        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([
          { type: "delta", text: "Hello" },
          { type: "delta", text: " there" },
          { type: "done", model: "@cf/meta/llama-3.1-8b-instruct" },
        ]);
        expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.1-8b-instruct", {
          messages: MSG.messages,
          max_tokens: 1024,
          stream: true,
        });
      });

      it("binding rejection is mapped to an error event, not a throw", async () => {
        cfState.ai = { run: vi.fn().mockRejectedValue(new Error("boom")) };
        const events = await collect(provider.generateStream(MSG));
        expect(events).toHaveLength(1);
        const err = events[0] as { type: "error"; error: string };
        expect(err.type).toBe("error");
        expect(err.error).toContain("boom");
      });

      it("deadline already exceeded before the binding responds → single { type:'error', error:'timeout' } event", async () => {
        // withDeadline 對「絕對時間點」扣時(ai.run() 非 fetch,沒有 AbortSignal)。
        // 用 Date.now 假造「deadline 算完後、實際檢查時已經過期」,不必真的等
        // GENERATE_TIMEOUT_MS(60s)或依賴 fake timers 在 workers pool 下的相容性。
        const nowSpy = vi.spyOn(Date, "now");
        nowSpy.mockReturnValueOnce(1_000); // deadlineAt = 1_000 + 60_000
        nowSpy.mockReturnValueOnce(200_000); // remaining < 0 → immediate timeout
        cfState.ai = { run: vi.fn(async () => sseStream("data: [DONE]\n\n")) };

        const events = await collect(provider.generateStream(MSG));
        expect(events).toEqual([{ type: "error", error: "timeout" }]);
        nowSpy.mockRestore();
      });
    });
  });
});
