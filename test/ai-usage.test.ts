import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// AI token 用量(CORE_API 1.34.0,docs/spec-admin-agent.md §3.2)的測試。
//
// 三段,由淺到深:
//   1. **解析** —— 三種 mode、串流與非串流,usage 有沒有被正確地讀出來。
//   2. **落庫** —— src/ext/ai-usage.ts 的兩條契約:append-only 與 fail-open。
//   3. **接線** —— agent loop 每一次上游呼叫一列、失敗也記、outcome 的聚合。
//
// 貫穿三段的那一條斷言,比「有沒有讀到數字」重要得多:
//
//     **上游沒回報時是 null,不是 0。**
//
// 0 是「上游說這次用了零個」,缺席是「上游沒說」。把後者寫成 0,事後 SUM 出來的
// 總額會看起來像一份完整的帳,而它其實有缺口 —— 而點數制正是要建立在那個總和上。
// 同理:「打了一次但不知道用了多少」與「沒打」也必須分得出來,所以拿不到 usage
// 的呼叫**仍然要有一列**(兩個 token 欄位為 NULL),而不是不寫。
//
// mocking 手法混合了兩套既有慣例,因為這一檔同時碰 provider 與 D1:
//   · settings / AI binding 替身 —— 同 test/ai-chat.test.ts(SSE body 是手打的 wire
//     文字經真的 Response 轉成真的 ReadableStream,測的是本專案自己寫的解析);
//   · @/lib/cf 的 getDB 接上真的 D1 binding —— 同 test/agent-loop.test.ts(用量有沒有
//     真的落地,要在資料庫裡看得見,不從回傳值反推)。

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
  getEnv: () => env,
  getDB: () => (env as { DB: D1Database }).DB,
  getStorage: () => undefined,
}));

// loadAgentSystemPrompt 不在本檔的路徑上,但 agent-tools 的相依鏈會經 loader ——
// 真實 loader 在 workers pool 載不起來(經 interpret → views → next/navigation)。
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({}) }));

import { z } from "zod";
import { CoreAiProvider } from "../src/ext/providers/ai";
import type {
  AiChatOptions,
  AiChatResult,
  AiChatStreamEvent,
  AiChatUsage,
  AiToolDef,
} from "../src/ext/providers/ai";
import {
  AI_USAGE_ERROR_MAX,
  AI_USAGE_FEATURE_AGENT_CHAT,
  recordAiUsage,
} from "../src/ext/ai-usage";
import { runAgentChat } from "../src/ext/agent-loop";
import {
  AgentToolRegistryImpl,
  defineAgentTool,
} from "../src/ext/agent-tools";
import type { AgentToolCtx } from "../src/ext/agent-tools";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const AI_USAGE_DDL =
  "CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, feature TEXT NOT NULL, mode TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, user_id TEXT NOT NULL, user_email TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);";

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
  avatarKey: null,
};

/** loop 只用到 ctx.user;tools 是測試自己的替身,不碰 providers。 */
const CTX = { user: ADMIN, services: {} } as unknown as AgentToolCtx;

interface UsageRow {
  feature: string;
  mode: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  user_id: string;
  user_email: string;
  ok: number;
  error: string | null;
}

async function usageRows(): Promise<UsageRow[]> {
  const res = await d1()
    .prepare("SELECT * FROM ai_usage ORDER BY at, rowid")
    .all<UsageRow>();
  return res.results;
}

beforeAll(async () => {
  await d1().exec(AI_USAGE_DDL);
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, user_email TEXT NOT NULL, tool TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT, error TEXT);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM ai_usage;");
  await d1().exec("DELETE FROM agent_audit;");
  settingsState.values = {};
  cfState.ai = undefined;
});

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 手打的 SSE 文字 → 真的 Response(res.body 是真的 ReadableStream)。 */
function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const TOOLS: AiToolDef[] = [
  {
    name: "core.content.list",
    description: "List content items",
    inputSchema: { type: "object", properties: {} },
  },
];

const ASK: AiChatOptions = {
  messages: [{ role: "user", content: [{ type: "text", text: "list posts" }] }],
  tools: TOOLS,
};

async function collect(
  gen: AsyncGenerator<AiChatStreamEvent>,
): Promise<AiChatStreamEvent[]> {
  const out: AiChatStreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function lastResult(events: readonly AiChatStreamEvent[]): AiChatResult {
  const last = events[events.length - 1];
  expect(last?.type).toBe("result");
  if (last?.type !== "result") throw new Error("unreachable");
  return last.result;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): unknown {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

// ---------------------------------------------------------------------------
// 1. 解析
// ---------------------------------------------------------------------------

describe("usage 解析 —— 非串流", () => {
  const provider = new CoreAiProvider();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("openai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.model": "gpt-4o-mini",
        "core.ai.apiKey": "sk-secret",
      };
    });

    const reply = (usage: unknown): Response =>
      jsonResponse(200, {
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        ...(usage === undefined ? {} : { usage }),
      });

    it("讀 usage.prompt_tokens / completion_tokens", async () => {
      fetchMock.mockResolvedValueOnce(
        reply({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }),
      );
      const res = await provider.chat(ASK);
      expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    });

    it("上游整個沒回報 usage → 這個鍵不存在(不是 0)", async () => {
      fetchMock.mockResolvedValueOnce(reply(undefined));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(true);
      expect(res.usage).toBeUndefined();
      expect("usage" in res).toBe(false);
    });

    it("上游真的回 0 → 保留 0(這與「沒回報」是兩件事)", async () => {
      fetchMock.mockResolvedValueOnce(
        reply({ prompt_tokens: 0, completion_tokens: 0 }),
      );
      const res = await provider.chat(ASK);
      expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it("只回其中一欄 → 只有那一欄,另一欄不存在", async () => {
      fetchMock.mockResolvedValueOnce(reply({ completion_tokens: 7 }));
      const res = await provider.chat(ASK);
      expect(res.usage).toEqual({ outputTokens: 7 });
      expect(res.usage && "inputTokens" in res.usage).toBe(false);
    });

    it("不可信的值(字串 / 負數 / NaN)一律當作沒回報,不硬轉", async () => {
      fetchMock.mockResolvedValueOnce(
        reply({ prompt_tokens: "12", completion_tokens: -1 }),
      );
      expect((await provider.chat(ASK)).usage).toBeUndefined();

      fetchMock.mockResolvedValueOnce(
        reply({ prompt_tokens: Number.NaN, completion_tokens: null }),
      );
      expect((await provider.chat(ASK)).usage).toBeUndefined();
    });

    it("usage 不是物件 → 不當一回事,也不 throw", async () => {
      fetchMock.mockResolvedValueOnce(reply("lots"));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(true);
      expect(res.usage).toBeUndefined();
    });
  });

  describe("anthropic mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "anthropic",
        "core.ai.model": "claude-x",
        "core.ai.apiKey": "sk-ant-secret",
      };
    });

    const reply = (usage: unknown): Response =>
      jsonResponse(200, {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        ...(usage === undefined ? {} : { usage }),
      });

    it("讀 usage.input_tokens / output_tokens", async () => {
      fetchMock.mockResolvedValueOnce(
        reply({ input_tokens: 25, output_tokens: 42 }),
      );
      expect((await provider.chat(ASK)).usage).toEqual({
        inputTokens: 25,
        outputTokens: 42,
      });
    });

    it("沒回報 → 鍵不存在", async () => {
      fetchMock.mockResolvedValueOnce(reply(undefined));
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(true);
      expect("usage" in res).toBe(false);
    });

    it("不認得 openai 的欄位名(不猜、不換算)", async () => {
      fetchMock.mockResolvedValueOnce(
        reply({ prompt_tokens: 25, completion_tokens: 42 }),
      );
      expect((await provider.chat(ASK)).usage).toBeUndefined();
    });
  });

  describe("workers-ai mode(盡力而為)", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "workers-ai",
        "core.ai.model": "@cf/meta/llama",
      };
    });

    it("回應帶 usage 就讀", async () => {
      cfState.ai = {
        run: async () => ({
          response: "hi",
          usage: { prompt_tokens: 8, completion_tokens: 9 },
        }),
      };
      expect((await provider.chat(ASK)).usage).toEqual({
        inputTokens: 8,
        outputTokens: 9,
      });
    });

    it("回應沒有 usage → 留白,不編一個出來", async () => {
      cfState.ai = { run: async () => ({ response: "hi" }) };
      const res = await provider.chat(ASK);
      expect(res.ok).toBe(true);
      expect(res.usage).toBeUndefined();
    });
  });
});

describe("usage 解析 —— 串流", () => {
  const provider = new CoreAiProvider();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("openai mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "openai",
        "core.ai.model": "gpt-4o-mini",
        "core.ai.apiKey": "sk-secret",
      };
    });

    const TEXT_CHUNKS =
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`;
    /** usage 在 [DONE] 之前的最後一個 chunk,而它的 choices 是**空陣列**。 */
    const USAGE_CHUNK = `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n`;

    it("request 主動要 usage(stream_options.include_usage)", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(TEXT_CHUNKS + USAGE_CHUNK + `data: [DONE]\n\n`),
      );
      await collect(provider.chatStream(ASK));
      expect(bodyOf(fetchMock)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    // 這一組釘的是取捨本身:**用量是加分,對話是本分**。接的是任意
    // OpenAI-compatible 端點,而那些代理對不認得的頂層鍵會整份 400
    // (2026-08-07 的點分 tool name 事故是同一類)。
    it("代理以 400 拒收 stream_options → 原封不動重送一次不帶的,對話照跑", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { error: { message: "unknown field stream_options" } }),
      );
      fetchMock.mockResolvedValueOnce(sseResponse(TEXT_CHUNKS + `data: [DONE]\n\n`));

      const res = lastResult(await collect(provider.chatStream(ASK)));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(fetchMock, 0)).toMatchObject({
        stream_options: { include_usage: true },
      });
      // 重送的那一份除了少掉那個鍵,其餘必須一字不差 —— 退化的是用量,不是請求。
      const first = bodyOf(fetchMock, 0) as Record<string, unknown>;
      const second = bodyOf(fetchMock, 1) as Record<string, unknown>;
      expect(second).not.toHaveProperty("stream_options");
      delete first.stream_options;
      expect(second).toEqual(first);

      // 對話成功,只是沒有用量數字。
      expect(res.ok).toBe(true);
      expect(res.text).toBe("Hello");
      expect(res.usage).toBeUndefined();
    });

    it("401 / 429 不重送 —— 與欄位無關,重送只是多花一次錢", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(429, { error: { message: "rate limited" } }),
      );
      const res = lastResult(await collect(provider.chatStream(ASK)));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(false);
    });

    it("choices 為空陣列的 usage chunk 不絆住解析,而且真的被讀進 result", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(TEXT_CHUNKS + USAGE_CHUNK + `data: [DONE]\n\n`),
      );
      const events = await collect(provider.chatStream(ASK));
      const res = lastResult(events);
      expect(res.ok).toBe(true);
      expect(res.text).toBe("Hello");
      expect(res.stopReason).toBe("end_turn");
      expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    });

    it("同一份用量:串流與非串流算出的 usage 完全一致", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(TEXT_CHUNKS + USAGE_CHUNK + `data: [DONE]\n\n`),
      );
      const streamed = lastResult(await collect(provider.chatStream(ASK)));

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      );
      const once = await provider.chat(ASK);

      expect(streamed.usage).toEqual(once.usage);
      expect(streamed).toEqual(once);
    });

    it("上游沒送 usage chunk(代理吃掉了)→ 鍵不存在,其餘一切照舊", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(TEXT_CHUNKS + `data: [DONE]\n\n`),
      );
      const res = lastResult(await collect(provider.chatStream(ASK)));
      expect(res.ok).toBe(true);
      expect(res.text).toBe("Hello");
      expect("usage" in res).toBe(false);
    });

    it("只有 usage、一個字都沒吐的串流仍是失敗(空成功的紀律未變)", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(USAGE_CHUNK));
      const res = lastResult(await collect(provider.chatStream(ASK)));
      expect(res).toEqual({ ok: false, error: "openai: empty stream" });
    });
  });

  describe("anthropic mode", () => {
    beforeEach(() => {
      settingsState.values = {
        "core.ai.mode": "anthropic",
        "core.ai.model": "claude-x",
        "core.ai.apiKey": "sk-ant-secret",
      };
    });

    /** message_start 帶 input;message_delta 帶**累積的** output(這裡送兩次)。 */
    const SSE =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

    it("message_start 的 input 與 message_delta 的 output 都收得到", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(SSE));
      const res = lastResult(await collect(provider.chatStream(ASK)));
      expect(res.ok).toBe(true);
      expect(res.text).toBe("Hi");
      expect(res.usage).toEqual({ inputTokens: 25, outputTokens: 42 });
    });

    it("output_tokens 是累積值 —— 覆蓋,不是相加", async () => {
      fetchMock.mockResolvedValueOnce(sseResponse(SSE));
      const res = lastResult(await collect(provider.chatStream(ASK)));
      // 相加會是 1 + 7 + 42 = 50。最後一個才是這一次呼叫的真實數字。
      expect(res.usage?.outputTokens).toBe(42);
    });

    it("上游沒送 usage → 鍵不存在", async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n` +
            `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
        ),
      );
      const res = lastResult(await collect(provider.chatStream(ASK)));
      expect(res.ok).toBe(true);
      expect("usage" in res).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 落庫
// ---------------------------------------------------------------------------

describe("recordAiUsage", () => {
  it("寫一列:who / feature / mode / model / tokens", async () => {
    settingsState.values = { "core.ai.mode": "openai" };
    await recordAiUsage({
      actor: ADMIN,
      feature: AI_USAGE_FEATURE_AGENT_CHAT,
      model: "gpt-4o-mini",
      usage: { inputTokens: 12, outputTokens: 34 },
      ok: true,
    });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "agent.chat",
      mode: "openai",
      model: "gpt-4o-mini",
      input_tokens: 12,
      output_tokens: 34,
      user_id: "u-admin",
      user_email: "admin@test.com",
      ok: 1,
      error: null,
    });
  });

  it("上游沒回報 usage → 兩個 token 欄位是 NULL,不是 0", async () => {
    await recordAiUsage({
      actor: ADMIN,
      feature: AI_USAGE_FEATURE_AGENT_CHAT,
      model: "gpt-4o-mini",
      ok: true,
    });

    const [row] = await usageRows();
    expect(row?.input_tokens).toBeNull();
    expect(row?.output_tokens).toBeNull();
  });

  it("上游回 0 → 存 0(與 NULL 分得出來)", async () => {
    await recordAiUsage({
      actor: ADMIN,
      feature: AI_USAGE_FEATURE_AGENT_CHAT,
      usage: { inputTokens: 0, outputTokens: 0 },
      ok: true,
    });

    const [row] = await usageRows();
    expect(row?.input_tokens).toBe(0);
    expect(row?.output_tokens).toBe(0);
  });

  it("設定讀不到 mode → NULL,那一列仍然寫得下去", async () => {
    await recordAiUsage({
      actor: ADMIN,
      feature: AI_USAGE_FEATURE_AGENT_CHAT,
      ok: true,
    });
    const [row] = await usageRows();
    expect(row?.mode).toBeNull();
  });

  it("失敗的呼叫也記一列(ok=0),錯誤摘要截 200 字", async () => {
    await recordAiUsage({
      actor: ADMIN,
      feature: AI_USAGE_FEATURE_AGENT_CHAT,
      ok: false,
      error: "x".repeat(500),
    });

    const [row] = await usageRows();
    expect(row?.ok).toBe(0);
    expect(row?.error).toBe(`${"x".repeat(AI_USAGE_ERROR_MAX)}…`);
    expect(row?.input_tokens).toBeNull();
  });

  it("fail-open:表不存在時不 throw,只 console.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await d1().exec("DROP TABLE ai_usage;");
    try {
      await expect(
        recordAiUsage({
          actor: ADMIN,
          feature: AI_USAGE_FEATURE_AGENT_CHAT,
          usage: { inputTokens: 1 },
          ok: true,
        }),
      ).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await d1().exec(AI_USAGE_DDL);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. agent loop 接線
// ---------------------------------------------------------------------------

describe("agent loop 的用量接線", () => {
  function makeRegistry(): AgentToolRegistryImpl {
    const registry = new AgentToolRegistryImpl();
    registry.register(
      defineAgentTool({
        name: "test.thing.list",
        description: "List the things.",
        kind: "read",
        schema: z.object({}).strict(),
        run: async () => ({ hits: ["a"] }),
      }),
    );
    return registry;
  }

  function toolStep(usage?: AiChatUsage): AiChatResult {
    return {
      ok: true,
      text: "",
      toolUses: [{ id: "tu-1", name: "test.thing.list", input: {} }],
      stopReason: "tool_use",
      model: "fake-model",
      ...(usage ? { usage } : {}),
    };
  }

  function finalStep(usage?: AiChatUsage): AiChatResult {
    return {
      ok: true,
      text: "done",
      toolUses: [],
      stopReason: "end_turn",
      model: "fake-model",
      ...(usage ? { usage } : {}),
    };
  }

  function scripted(results: AiChatResult[]): (opts: AiChatOptions) => Promise<AiChatResult> {
    let i = 0;
    return async () => results[i++] ?? results[results.length - 1]!;
  }

  const base = {
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    ],
    system: "be helpful",
    ctx: CTX,
  };

  it("一次上游呼叫一列 —— 兩步就是兩列(不是一則訊息一列)", async () => {
    settingsState.values = { "core.ai.mode": "anthropic" };
    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chat: scripted([
        toolStep({ inputTokens: 100, outputTokens: 20 }),
        finalStep({ inputTokens: 180, outputTokens: 30 }),
      ]),
    });

    expect(outcome.status).toBe("text");
    expect(outcome.steps).toBe(2);

    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.input_tokens, r.output_tokens])).toEqual([
      [100, 20],
      [180, 30],
    ]);
    expect(rows.every((r) => r.feature === "agent.chat" && r.ok === 1)).toBe(true);
    expect(rows.every((r) => r.mode === "anthropic")).toBe(true);
    expect(rows.every((r) => r.user_id === "u-admin")).toBe(true);
  });

  it("outcome 帶這一則訊息的總和", async () => {
    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chat: scripted([
        toolStep({ inputTokens: 100, outputTokens: 20 }),
        finalStep({ inputTokens: 180, outputTokens: 30 }),
      ]),
    });
    expect(outcome.usage).toEqual({ inputTokens: 280, outputTokens: 50 });
  });

  it("只有部分步驟報得出數字 → 加總只算報得出來的那些", async () => {
    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chat: scripted([toolStep(), finalStep({ outputTokens: 30 })]),
    });
    // input 從頭到尾沒有人報過 → 那一欄不存在,不是 0。
    expect(outcome.usage).toEqual({ outputTokens: 30 });
    expect(outcome.usage && "inputTokens" in outcome.usage).toBe(false);
  });

  it("一步都沒報 → outcome 沒有 usage 鍵,但每一次呼叫仍各有一列(token 為 NULL)", async () => {
    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chat: scripted([toolStep(), finalStep()]),
    });
    expect(outcome.usage).toBeUndefined();
    expect("usage" in outcome).toBe(false);

    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    // 「打了兩次但不知道多少」與「沒打」的差別,就是這兩列存不存在。
    expect(rows.every((r) => r.input_tokens === null && r.output_tokens === null)).toBe(
      true,
    );
  });

  it("上游失敗也記一列(ok=0 + 錯誤摘要)—— 失敗的請求一樣花錢", async () => {
    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chat: scripted([{ ok: false, error: "openai 429: slow down" }]),
    });

    expect(outcome.status).toBe("error");
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ok: 0,
      error: "openai 429: slow down",
      input_tokens: null,
      output_tokens: null,
    });
  });

  it("串流路徑一樣記,而且記的是 result 事件裡的 usage", async () => {
    const events: AiChatStreamEvent[][] = [
      [
        { type: "text_delta", text: "查" },
        { type: "result", result: toolStep({ inputTokens: 9, outputTokens: 1 }) },
      ],
      [{ type: "result", result: finalStep({ inputTokens: 11, outputTokens: 4 }) }],
    ];
    let i = 0;
    async function* chatStream(): AsyncGenerator<AiChatStreamEvent> {
      const batch = events[i++] ?? events[events.length - 1]!;
      for (const e of batch) yield e;
    }

    const outcome = await runAgentChat({
      ...base,
      registry: makeRegistry(),
      chatStream,
      onEvent: () => {},
    });

    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
    const rows = await usageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([9, 11]);
  });

  it("記不成用量不會讓對話失敗(fail-open 貫穿到 loop)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await d1().exec("DROP TABLE ai_usage;");
    try {
      const outcome = await runAgentChat({
        ...base,
        registry: makeRegistry(),
        chat: scripted([finalStep({ inputTokens: 5, outputTokens: 5 })]),
      });
      expect(outcome.status).toBe("text");
      // 落庫失敗與否,回給使用者的那份聚合照樣算得出來。
      expect(outcome.usage).toEqual({ inputTokens: 5, outputTokens: 5 });
    } finally {
      spy.mockRestore();
      await d1().exec(AI_USAGE_DDL);
    }
  });
});
