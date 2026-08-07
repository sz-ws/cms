import { getSetting } from "@/lib/settings";
import { getAI } from "@/lib/cf";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_VERSION,
  GENERATE_TIMEOUT_MS,
  OPENAI_DEFAULT_BASE_URL,
  safeJsonParse,
  truncate,
  withTimeout,
} from "./ai-shared";

// ai:generate v1.2 —— tool calling(docs/spec-admin-agent.md §3)。
//
// 沿 v1.1 streaming 的前例:對 AiProvider **加一個選用方法**,既有 generate /
// generateStream 一個字都不動。型別在此宣告、由 ./ai.ts 原樣 re-export,所以對外
// 的 import 路徑仍是 "@/ext/providers/ai"(介面宣告處);實作放這裡純粹是因為
// ai.ts 已近 700 行,三種 mode 的 wire format 再塞進去會破 800 行上限。
//
// v1 非 streaming(spec §3 當時明定);v1.1(CORE_API 1.32.0)補上 —— 收益不在
// write 提案(那本來就要停下來等人),在**多步 read loop**:8 步的整段黑箱等待
// 換成邊查邊講。串流的實作住 ./ai-chat-stream.ts,本檔負責的是**兩條路共用的規則**
// (wire 名換名、messages 轉換、stopReason 正規化、tool arguments 解析),故那些
// 內部件由此 export —— 複製一份到串流那邊就是留一條「串流與非串流的結果會分岔」
// 的縫,而 spec 要求兩者對同一回應算出的 AiChatResult 完全一致。
//
// 共同慣例全沿用 generate():永不 throw(錯誤走 {ok:false, error})、60s 逾時、
// 上游錯誤摘要截 200 字、錯誤字串絕不含 apiKey、設定不全 → not_configured。

/** 餵給 LLM 的 tool 宣告(spec §3)。inputSchema 是一個 JSON Schema object ——
 *  行動層(Phase A)由 tool 的 zod schema 轉出,這裡當作不透明物件原樣透傳,
 *  core 不再驗一次(驗 args 是執行端的事,見 spec §4 的 /execute)。 */
export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 對話內容塊。三種即涵蓋整個 agent loop:助理說話(text)、助理要求呼叫工具
 *  (tool_use)、把工具結果接回去(tool_result)。
 *
 *  形狀刻意貼近 Anthropic 原生 tool use(id / input / tool_use_id 的關係),因為
 *  那是三種 mode 裡資訊量最完整的一種 —— openai 的 tool_calls 與 workers-ai 都能
 *  由它單向降維推出來,反過來則會遺失資訊。 */
export type AiChatContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      /** 對應的 tool_use.id。 */
      toolUseId: string;
      /** 已序列化的結果字串(spec §4.5:tool_result 一律包成 JSON 字串再接回)。 */
      content: string;
      /** 工具執行失敗時標記;LLM 看得到失敗才會換路(spec §4.5)。 */
      isError?: boolean;
    };

/** transcript 的一則訊息。
 *
 *  role 刻意只有 user / assistant:system prompt 走 AiChatOptions.system 頂層欄位,
 *  不混進 messages —— (a) system 訊息永遠不會帶 tool_use/tool_result,放進同一個
 *  union 只會產生型別上合法、語意上無意義的組合;(b) anthropic 原生就是頂層
 *  system,openai 則由本檔在組 request 時前置成一則 system 訊息,兩邊都不必再做
 *  generate() 那種「從 messages 裡抽出 system」的還原手續。 */
export interface AiChatMessage {
  role: "user" | "assistant";
  content: AiChatContentBlock[];
}

export interface AiChatOptions {
  /** 對話 transcript(spec §4:由前端持有,server stateless)。 */
  messages: AiChatMessage[];
  /** 可為空陣列 —— 空的話不送 tools 欄位給上游(OpenAI 會拒絕空 tools 陣列)。 */
  tools: AiToolDef[];
  /** system prompt(spec §4.5:住 code、per-request 組裝)。 */
  system?: string;
  /** 省略 → 1024;上限 8192(同 generate())。 */
  maxTokens?: number;
}

/** 助理這一輪要求的一次工具呼叫。 */
export interface AiChatToolUse {
  /** 上游給的識別碼(workers-ai 不給,由本檔合成);tool_result 靠它接回。 */
  id: string;
  name: string;
  /** 未驗的參數 —— 由行動層的 zod schema 在執行端驗(spec §4)。 */
  input: unknown;
}

/** 正規化後的收尾原因。三家各自的字串收斂成這四個值,呼叫端不必認識上游詞彙。 */
export type AiChatStopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface AiChatResult {
  ok: boolean;
  /** ok=true 時必有(沒有文字時為空字串)。 */
  text?: string;
  /** ok=true 時必有(沒有工具呼叫時為空陣列)。 */
  toolUses?: AiChatToolUse[];
  /** ok=true 時必有。 */
  stopReason?: AiChatStopReason;
  /** "not_configured" | "timeout" | "tool_use_not_supported" | 上游錯誤摘要
   *  (截 200 字,絕不含 apiKey)。 */
  error?: string;
  /** 實際使用的 model(觀測用)。 */
  model?: string;
}

/** tool-calling streaming 的事件(1.32.0)。刻意只有兩種:
 *
 *  - `text_delta`:助理正在說的字,逐塊。**只給顯示用** —— transcript 的組裝一律
 *    走 result,把 delta 拼起來當真相會多出一份會與 result 分岔的內容。
 *  - `result`:**恆為最後一個事件**,且恆會出現(上游錯誤/逾時/斷流都收斂成
 *    `{ok:false, error}`)。呼叫端只要讀到它就結束,不必另外判斷 generator 有沒有
 *    正常收尾。
 *
 *  沒有 tool_use 的增量事件:tool 名與參數要等 arguments 串完才算數,半份 JSON
 *  對呼叫端沒有任何可用的意義,只會誘導出「先渲染再更正」的 UI。 */
export type AiChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "result"; result: AiChatResult };

/** 把一次 chat 結果還原成 assistant 訊息,供 loop 接回 transcript 續問
 *  (spec §4:tool_result 接回 messages 再跑下一步)。
 *
 *  刻意用函式而不是在 AiChatResult 裡多塞一個 message 欄位:同一份內容出現兩次
 *  就會有「哪個才算數」的問題,而還原規則(text 在前、tool_use 依序在後)是固定的。 */
export function toAssistantMessage(result: AiChatResult): AiChatMessage {
  const content: AiChatContentBlock[] = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const use of result.toolUses ?? []) {
    content.push({
      type: "tool_use",
      id: use.id,
      name: use.name,
      input: use.input,
    });
  }
  return { role: "assistant", content };
}

function textOf(blocks: AiChatContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<AiChatContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolUsesOf(
  blocks: AiChatContentBlock[],
): Extract<AiChatContentBlock, { type: "tool_use" }>[] {
  return blocks.filter(
    (b): b is Extract<AiChatContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );
}

/** id → tool 名稱。workers-ai 的 tool 結果訊息要帶 name(它的 tool_calls 不給 id,
 *  所以無法像 openai 那樣只靠 id 對回去),從整份 transcript 的 tool_use 建表。 */
function toolNamesById(messages: AiChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const use of toolUsesOf(msg.content)) map.set(use.id, use.name);
  }
  return map;
}

/** 有 tool_use 就一律以 "tool_use" 收尾 —— 不完全信任上游的 finish/stop reason
 *  字串(OpenAI-compatible 代理常在帶 tool_calls 時仍回 "stop")。有實際的工具
 *  呼叫是比一個字串更硬的事實。 */
export function normalizeStopReason(
  raw: string | undefined,
  hasToolUse: boolean,
  maxTokensValues: readonly string[],
  endTurnValues: readonly string[],
): AiChatStopReason {
  if (hasToolUse) return "tool_use";
  if (raw && maxTokensValues.includes(raw)) return "max_tokens";
  if (raw && endTurnValues.includes(raw)) return "end_turn";
  return "other";
}

// ---------------------------------------------------------------------------
// wire-safe tool 名
// ---------------------------------------------------------------------------

// 三家上游對 tool/function name 的規則都是 ^[a-zA-Z0-9_-]{1,64}$ —— **不允許點**。
// 行動層的正名是點分文法(content.gallery_item.list,agent-tools.ts 的
// AGENT_TOOL_NAME_RE),原樣上線就是 400(2026-08-07 實機驗證,OpenAI-compatible
// 代理直接拒收)。取捨:正名不改 —— spec、audit、面板的 namespace/leaf 拆解、
// slash 選單全建立在點分文法上 —— 改在 wire 邊界雙向換:出去點換破折號,回來查表
// 還原。破折號在正名文法裡不合法,所以替換可逆、不需要 per-request 暫存;查表
// 而不是逆向字串替換,是為了超長名的雜湊尾碼(逆推不回來)與非行動層呼叫端
// 傳進來的任意名字(可能本來就含破折號)。

const WIRE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const WIRE_TOOL_NAME_MAX = 64;

export function toWireToolName(name: string): string {
  if (WIRE_TOOL_NAME_RE.test(name)) return name;
  const dashed = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (dashed.length <= WIRE_TOOL_NAME_MAX) return dashed;
  // 超長時穩定截斷:尾碼由全名雜湊(djb2)推導,同名跨回合永遠得到同一個 wire 名
  // —— transcript 重送時前後兩次請求的名字才對得上。
  let h = 5381;
  for (let i = 0; i < dashed.length; i++) {
    h = ((h * 33) ^ dashed.charCodeAt(i)) >>> 0;
  }
  const suffix = h.toString(36);
  return `${dashed.slice(0, WIRE_TOOL_NAME_MAX - suffix.length - 1)}-${suffix}`;
}

export interface WireChat {
  /** tools 與 messages 裡的 tool_use 名都已換成 wire 名的 opts。 */
  opts: AiChatOptions;
  /** 上游回的 wire 名 → 正名。查不到(模型自創的名字)原樣保留,讓呼叫端走
   *  既有的 unknown_tool 路徑 —— 這裡不猜。 */
  fromWire(name: string): string;
}

export function toWireChat(source: AiChatOptions): WireChat {
  const byWire = new Map<string, string>();
  for (const tool of source.tools) {
    byWire.set(toWireToolName(tool.name), tool.name);
  }
  return {
    opts: {
      ...source,
      tools: source.tools.map((t) => ({ ...t, name: toWireToolName(t.name) })),
      messages: source.messages.map((m) => ({
        ...m,
        content: m.content.map((b) =>
          b.type === "tool_use" ? { ...b, name: toWireToolName(b.name) } : b,
        ),
      })),
    },
    fromWire: (name) => byWire.get(name) ?? name,
  };
}

// ---------------------------------------------------------------------------
// openai mode —— function calling wire format
// ---------------------------------------------------------------------------

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** OpenAI 的 tool_calls.function.arguments 是 **JSON 字串**(不是物件)。
 *  解析失敗時原樣保留字串而不是吞成 {}:下游用 tool 的 zod schema 驗參數,收到
 *  字串會報「expected object」,LLM 看得見自己送壞了、有機會改正;吞成 {} 反而
 *  變成看似「少帶必填欄位」的假訊息,查起來更遠。 */
export function parseToolArguments(raw: string | undefined): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  const parsed = safeJsonParse<unknown>(raw);
  return parsed === null ? raw : parsed;
}

export function toOpenAiMessages(opts: AiChatOptions): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (opts.system) out.push({ role: "system", content: opts.system });
  for (const msg of opts.messages) {
    const text = textOf(msg.content);
    if (msg.role === "assistant") {
      const toolCalls: OpenAiToolCall[] = toolUsesOf(msg.content).map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      // content 與 tool_calls 皆空的 assistant 訊息會被上游拒絕,直接略過。
      if (text.length === 0 && toolCalls.length === 0) continue;
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user 側:tool_result 必須先於同一則訊息裡的文字送出 —— OpenAI 要求
    // role:"tool" 訊息緊接在帶 tool_calls 的 assistant 訊息之後,中間插一則
    // user 訊息就會被判為格式錯誤。
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.content,
        });
      }
    }
    if (text.length > 0) out.push({ role: "user", content: text });
  }
  return out;
}

export async function chatOpenAi(
  source: AiChatOptions,
  model: string,
  maxTokens: number,
): Promise<AiChatResult> {
  const wire = toWireChat(source);
  const opts = wire.opts;
  const apiKey = await getSetting<string>("core.ai.apiKey", "");
  if (!apiKey) return { ok: false, error: "not_configured" };
  const baseUrl =
    (await getSetting<string>("core.ai.baseUrl", "")) || OPENAI_DEFAULT_BASE_URL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages(opts),
        max_tokens: maxTokens,
        // 空 tools 陣列會被 OpenAI 拒絕;沒有工具時就當一般對話送。
        // tool_choice 刻意不送:預設就是 auto,少送一個欄位少一分與
        // OpenAI-compatible 代理不相容的機會。
        ...(opts.tools.length > 0
          ? {
              tools: opts.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return {
        ok: false,
        error: truncate(
          `openai ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
        ),
      };
    }

    const body = (await res.json().catch(() => null)) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
        finish_reason?: string;
      }[];
    } | null;
    const choice = body?.choices?.[0];
    if (!choice?.message) {
      return { ok: false, error: "openai: unexpected response shape" };
    }
    const toolUses: AiChatToolUse[] = (
      Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []
    )
      .filter(
        (c) => typeof c?.id === "string" && typeof c?.function?.name === "string",
      )
      .map((c) => ({
        id: c.id,
        name: wire.fromWire(c.function.name),
        input: parseToolArguments(c.function.arguments),
      }));
    return {
      ok: true,
      text: typeof choice.message.content === "string" ? choice.message.content : "",
      toolUses,
      stopReason: normalizeStopReason(
        choice.finish_reason,
        toolUses.length > 0,
        ["length"],
        ["stop"],
      ),
      model,
    };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return {
      ok: false,
      error: truncate(
        `openai network_error${e instanceof Error ? `: ${e.message}` : ""}`,
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// anthropic mode —— 原生 tool use
// ---------------------------------------------------------------------------

export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export function toAnthropicBlock(block: AiChatContentBlock): AnthropicBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  };
}

export async function chatAnthropic(
  source: AiChatOptions,
  model: string,
  maxTokens: number,
): Promise<AiChatResult> {
  const wire = toWireChat(source);
  const opts = wire.opts;
  const apiKey = await getSetting<string>("core.ai.apiKey", "");
  if (!apiKey) return { ok: false, error: "not_configured" };
  const baseUrl =
    (await getSetting<string>("core.ai.baseUrl", "")) ||
    ANTHROPIC_DEFAULT_BASE_URL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // 空 content 的訊息會被上游拒絕(同 openai 的空 assistant 訊息)。
        messages: opts.messages
          .filter((m) => m.content.length > 0)
          .map((m) => ({ role: m.role, content: m.content.map(toAnthropicBlock) })),
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.tools.length > 0
          ? {
              tools: opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return {
        ok: false,
        error: truncate(
          `anthropic ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
        ),
      };
    }

    const body = (await res.json().catch(() => null)) as {
      content?: AnthropicBlock[];
      stop_reason?: string;
    } | null;
    if (!body || !Array.isArray(body.content)) {
      return { ok: false, error: "anthropic: unexpected response shape" };
    }
    const text = body.content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join("");
    const toolUses: AiChatToolUse[] = body.content
      .filter(
        (c) =>
          c?.type === "tool_use" &&
          typeof c.id === "string" &&
          typeof c.name === "string",
      )
      .map((c) => ({
        id: c.id as string,
        name: wire.fromWire(c.name as string),
        input: c.input ?? {},
      }));
    return {
      ok: true,
      text,
      toolUses,
      stopReason: normalizeStopReason(
        body.stop_reason,
        toolUses.length > 0,
        ["max_tokens"],
        ["end_turn", "stop_sequence"],
      ),
      model,
    };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return {
      ok: false,
      error: truncate(
        `anthropic network_error${e instanceof Error ? `: ${e.message}` : ""}`,
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// workers-ai mode —— 僅部分模型支援(spec §3)
// ---------------------------------------------------------------------------

interface WorkersAiToolCall {
  name?: string;
  arguments?: unknown;
}

interface WorkersAiMessage {
  role: string;
  content: string;
  name?: string;
  tool_calls?: { name: string; arguments: unknown }[];
}

function toWorkersAiMessages(opts: AiChatOptions): WorkersAiMessage[] {
  const names = toolNamesById(opts.messages);
  const out: WorkersAiMessage[] = [];
  if (opts.system) out.push({ role: "system", content: opts.system });
  for (const msg of opts.messages) {
    const text = textOf(msg.content);
    if (msg.role === "assistant") {
      const uses = toolUsesOf(msg.content);
      if (uses.length > 0) {
        out.push({
          role: "assistant",
          content: text,
          tool_calls: uses.map((u) => ({
            name: u.name,
            arguments: u.input ?? {},
          })),
        });
      } else if (text.length > 0) {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    // 同 openai:工具結果要緊接在提出呼叫的那一輪之後,排在同一則訊息的文字之前。
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      // workers-ai 的工具結果訊息以 name 對應(它的 tool_calls 不給 id),
      // 故從 transcript 的 tool_use 反查;查不到就不帶 name。
      const name = names.get(block.toolUseId);
      out.push({
        role: "tool",
        content: block.content,
        ...(name ? { name } : {}),
      });
    }
    if (text.length > 0) out.push({ role: "user", content: text });
  }
  return out;
}

/** spec §3:workers-ai 僅部分模型支援 tool use。判定刻意從簡 —— 不維護模型白名單
 *  (Cloudflare 的模型目錄變動比這個 repo 快,白名單只會變成過期的謊言),試打
 *  失敗就退 tool_use_not_supported。
 *
 *  逾時是例外,仍回 "timeout":60s 預算是三種 mode 的共同慣例(spec §3),把它
 *  併進 tool_use_not_supported 會讓「網路慢」看起來像「模型不支援」。
 *
 *  另一個刻意的判斷:模型完全無視 tools、只回一段文字,視為**合法的文字回覆**
 *  (ok:true、toolUses 空)而不是不支援 —— 具備工具能力的模型本來就可以選擇直接
 *  回答,把它判成不支援會產生假陰性。真正不認得的是「回應形狀完全對不上」。 */
export async function chatWorkersAi(
  source: AiChatOptions,
  model: string,
  maxTokens: number,
): Promise<AiChatResult> {
  const wire = toWireChat(source);
  const opts = wire.opts;
  const ai = getAI();
  if (!ai) return { ok: false, error: "not_configured" };
  try {
    const result = await withTimeout(
      ai.run(model, {
        messages: toWorkersAiMessages(opts),
        max_tokens: maxTokens,
        ...(opts.tools.length > 0
          ? {
              tools: opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            }
          : {}),
      }),
      GENERATE_TIMEOUT_MS,
    );
    const body = result as {
      response?: unknown;
      tool_calls?: WorkersAiToolCall[];
    } | null;
    const rawCalls = Array.isArray(body?.tool_calls) ? body.tool_calls : [];
    const toolUses: AiChatToolUse[] = rawCalls
      .filter((c) => typeof c?.name === "string")
      .map((c, i) => ({
        // workers-ai 不回 id,合成一個穩定的識別碼供 tool_result 接回。
        id: `wai_${i}_${c.name as string}`,
        name: wire.fromWire(c.name as string),
        input: c.arguments ?? {},
      }));
    const text = typeof body?.response === "string" ? body.response : "";
    if (toolUses.length === 0 && typeof body?.response !== "string") {
      return { ok: false, error: "tool_use_not_supported" };
    }
    return {
      ok: true,
      text,
      toolUses,
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      model,
    };
  } catch (e) {
    if (e instanceof Error && e.message === "timeout") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "tool_use_not_supported" };
  }
}
