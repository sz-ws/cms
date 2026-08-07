import { getSetting } from "@/lib/settings";
import { getAI } from "@/lib/cf";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_VERSION,
  GENERATE_TIMEOUT_MS,
  OPENAI_DEFAULT_BASE_URL,
  resolveMaxTokens,
  safeJsonParse,
  truncate,
  withDeadline,
  withTimeout,
  type AiMode,
} from "./ai-shared";
import { chatAnthropic, chatOpenAi, chatWorkersAi } from "./ai-chat";

// core ai:generate capability(docs/spec-ai-capability.md)。
//
// 介面住在 provider 模組、不進 capabilities.ts —— Capability 是 open union
// (capabilities.ts:6),同 email:send 前例,新 capability 名免改 core;
// registry.get<T>() 泛型取用。單一 "core" provider,設定驅動路由三種模式
// (openai-compatible / anthropic-compatible / Cloudflare Workers AI)。
// SEO 建議、alt 文字、摘要等未來功能都吃這一個口。
//
// v1 明確排除(見 spec「不做」段;streaming 已於 v1.1 追加——見
// docs/spec-ai-capability.md streaming 附錄 + 本檔 generateStream();tool use 已於
// v1.2 追加——見 docs/spec-admin-agent.md §3 + 本檔 chat() 與 ./ai-chat.ts):
// 圖像/多模態、embeddings、多組設定檔 / per-extension key。
//
// 共用內部件(逾時預算/錯誤摘要/maxTokens clamp/預設 baseUrl)住 ./ai-shared.ts,
// generate 與 chat 兩條路徑共享同一份規則。

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiGenerateOptions {
  /** 至少一則;system 可為首則(anthropic 模式下抽出併為頂層 system 字串)。 */
  messages: AiMessage[];
  /** 省略 → 1024;上限 8192(超過即 clamp,不報錯)。 */
  maxTokens?: number;
  /** 透傳,不驗範圍 —— 上游 provider 自己會擋。 */
  temperature?: number;
}

export interface AiGenerateResult {
  ok: boolean;
  /** ok=true 時必有。 */
  text?: string;
  /** "not_configured" | "timeout" | 上游錯誤摘要(截 200 字,絕不含 apiKey)。 */
  error?: string;
  /** 實際使用的 model(觀測用)。 */
  model?: string;
}

/** streaming 事件(v1.1,見 docs/spec-ai-capability.md streaming 附錄)。 */
export type AiStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; model?: string }
  | { type: "error"; error: string };

// v1.2 tool-calling 的型別(docs/spec-admin-agent.md §3)住 ./ai-chat.ts、由此
// re-export —— 對外的 import 路徑仍是 "@/ext/providers/ai"(AiProvider 介面宣告處),
// 拆檔純粹是為了守住檔案大小上限。
export type {
  AiChatContentBlock,
  AiChatMessage,
  AiChatOptions,
  AiChatResult,
  AiChatStopReason,
  AiChatToolUse,
  AiToolDef,
} from "./ai-chat";
export { toAssistantMessage, toWireToolName } from "./ai-chat";

import type { AiChatOptions, AiChatResult } from "./ai-chat";

export interface AiProvider {
  generate(opts: AiGenerateOptions): Promise<AiGenerateResult>;
  /** 選填:v1.1 streaming(見 docs/spec-ai-capability.md streaming 附錄)。未實作的
   *  provider 由呼叫端(src/lib/ai.ts)退回單一 error 事件,永不 throw。 */
  generateStream?(opts: AiGenerateOptions): AsyncGenerator<AiStreamEvent>;
  /** 選填:v1.2 tool calling(見 docs/spec-admin-agent.md §3)。非 streaming。
   *  未實作的 provider 由呼叫端(src/lib/ai.ts)退回
   *  `{ok:false, error:"tool_use_not_supported"}`,永不 throw。 */
  chat?(opts: AiChatOptions): Promise<AiChatResult>;
}

interface SseFrame {
  /** anthropic 用具名事件(`event: content_block_delta` 等);openai/workers-ai
   * 的 frame 只有 data 行,event 為 undefined。 */
  event?: string;
  data: string;
}

/** 把單一 SSE frame(`\n\n` 分隔的一段)解析成 { event?, data }。多個 data 行
 * 依 SSE 規範以 "\n" 接回;無 data 行(純 comment/其他欄位)回 null。 */
function parseSseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
    // 其餘欄位(id: / retry: / 純 comment ":")與本檔三種 provider 皆無關,略過。
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** 共用 SSE 串流解析器:openai / anthropic / workers-ai 三種 provider 的 SSE
 * 回應皆由此驅動(見各自 generateXxxStream)。frame 之間可能跨多次 TextDecoder
 * read 才湊齊,因此用 buffer 累積、以 "\n\n" 切 frame,絕不假設一次 read 剛好對齊
 * frame 邊界。
 *
 * deadlineAt 提供時(只有 workers-ai 傳):每次 reader.read() 都對同一個絕對時間點
 * 扣時,逾時 reject Error("timeout")。openai/anthropic 不傳 —— 這兩者的逾時已由
 * fetch 的 AbortController 覆蓋(abort 會讓進行中的 reader.read() reject
 * AbortError),無需在此重複計時。 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  deadlineAt?: number,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = deadlineAt
        ? await withDeadline(reader.read(), deadlineAt)
        : await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = parseSseFrame(rawFrame);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, "\n");
    if (buffer.trim().length > 0) {
      const frame = parseSseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

export class CoreAiProvider implements AiProvider {
  async generate(opts: AiGenerateOptions): Promise<AiGenerateResult> {
    const mode = await getSetting<AiMode>("core.ai.mode", "off");
    const model = await getSetting<string>("core.ai.model", "");
    // off / 缺 model → not_configured(openai|anthropic 缺 apiKey 的判定在各自分支,
    // 因為 workers-ai 不需要 apiKey)。
    if (mode === "off" || !model) {
      return { ok: false, error: "not_configured" };
    }
    const maxTokens = resolveMaxTokens(opts.maxTokens);

    if (mode === "openai") return this.generateOpenAi(opts, model, maxTokens);
    if (mode === "anthropic") {
      return this.generateAnthropic(opts, model, maxTokens);
    }
    if (mode === "workers-ai") {
      return this.generateWorkersAi(opts, model, maxTokens);
    }
    // 未知 mode 值(non-declarative 誤植等)→ 同樣視為未設定,永不 throw。
    return { ok: false, error: "not_configured" };
  }

  /** v1.1 streaming(見 docs/spec-ai-capability.md streaming 附錄)。前置檢查與
   * generate() 完全一致,差別只在「未設定」時 yield 單一 error 事件而非 return
   * 一個 result —— 同樣永不 throw。 */
  async *generateStream(opts: AiGenerateOptions): AsyncGenerator<AiStreamEvent> {
    const mode = await getSetting<AiMode>("core.ai.mode", "off");
    const model = await getSetting<string>("core.ai.model", "");
    if (mode === "off" || !model) {
      yield { type: "error", error: "not_configured" };
      return;
    }
    const maxTokens = resolveMaxTokens(opts.maxTokens);

    if (mode === "openai") {
      yield* this.generateOpenAiStream(opts, model, maxTokens);
      return;
    }
    if (mode === "anthropic") {
      yield* this.generateAnthropicStream(opts, model, maxTokens);
      return;
    }
    if (mode === "workers-ai") {
      yield* this.generateWorkersAiStream(opts, model, maxTokens);
      return;
    }
    yield { type: "error", error: "not_configured" };
  }

  /** v1.2 tool calling(見 docs/spec-admin-agent.md §3)。前置檢查與 generate()
   * 完全一致(mode off / 缺 model / 未知 mode → not_configured);三種 mode 的
   * wire format 各自住 ./ai-chat.ts。非 streaming —— spec §3 明定:確認制的 write
   * 提案本來就要停下來等人,串流沒有 UX 收益。 */
  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    const mode = await getSetting<AiMode>("core.ai.mode", "off");
    const model = await getSetting<string>("core.ai.model", "");
    if (mode === "off" || !model) {
      return { ok: false, error: "not_configured" };
    }
    const maxTokens = resolveMaxTokens(opts.maxTokens);

    if (mode === "openai") return chatOpenAi(opts, model, maxTokens);
    if (mode === "anthropic") return chatAnthropic(opts, model, maxTokens);
    if (mode === "workers-ai") return chatWorkersAi(opts, model, maxTokens);
    return { ok: false, error: "not_configured" };
  }

  private async generateOpenAi(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): Promise<AiGenerateResult> {
    const apiKey = await getSetting<string>("core.ai.apiKey", "");
    if (!apiKey) return { ok: false, error: "not_configured" };
    const baseUrl =
      (await getSetting<string>("core.ai.baseUrl", "")) ||
      OPENAI_DEFAULT_BASE_URL;

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
          messages: opts.messages,
          max_tokens: maxTokens,
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // OpenAI 錯誤體:{ error: { message, type, ... } }。絕不把 apiKey 拼入。
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
        choices?: { message?: { content?: string } }[];
      } | null;
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        return { ok: false, error: "openai: unexpected response shape" };
      }
      return { ok: true, text, model };
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

  /** generateOpenAi 的 streaming 版:同一份 body 多加 `stream: true`,回應改為
   * `text/event-stream`(`data: {...}` frame,終止 frame 為字面 `data: [DONE]`)。
   * 逾時語意同 generateOpenAi:AbortController 60s,abort 觸發的 AbortError → 單一
   * `{type:"error", error:"timeout"}` 事件。 */
  private async *generateOpenAiStream(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): AsyncGenerator<AiStreamEvent> {
    const apiKey = await getSetting<string>("core.ai.apiKey", "");
    if (!apiKey) {
      yield { type: "error", error: "not_configured" };
      return;
    }
    const baseUrl =
      (await getSetting<string>("core.ai.baseUrl", "")) ||
      OPENAI_DEFAULT_BASE_URL;

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
          messages: opts.messages,
          max_tokens: maxTokens,
          stream: true,
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        yield {
          type: "error",
          error: truncate(
            `openai ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
          ),
        };
        return;
      }
      if (!res.body) {
        yield { type: "error", error: "openai: empty stream body" };
        return;
      }

      for await (const frame of parseSseStream(res.body)) {
        if (frame.data === "[DONE]") {
          yield { type: "done", model };
          return;
        }
        const parsed = safeJsonParse<{
          choices?: { delta?: { content?: string } }[];
        }>(frame.data);
        const text = parsed?.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          yield { type: "delta", text };
        }
      }
      // 串流結束但沒收到明確的 [DONE] frame(上游行為不一定嚴謹)→ 防禦性補一個
      // done,避免呼叫端永遠卡在「還沒結束」的狀態。
      yield { type: "done", model };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        yield { type: "error", error: "timeout" };
        return;
      }
      yield {
        type: "error",
        error: truncate(
          `openai network_error${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async generateAnthropic(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): Promise<AiGenerateResult> {
    const apiKey = await getSetting<string>("core.ai.apiKey", "");
    if (!apiKey) return { ok: false, error: "not_configured" };
    const baseUrl =
      (await getSetting<string>("core.ai.baseUrl", "")) ||
      ANTHROPIC_DEFAULT_BASE_URL;

    // role=system 的訊息抽出併為頂層 system 字串(spec);其餘依原順序傳入 messages。
    const systemMessages = opts.messages.filter((m) => m.role === "system");
    const chatMessages = opts.messages.filter((m) => m.role !== "system");
    const system =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join("\n\n")
        : undefined;

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
          messages: chatMessages,
          ...(system ? { system } : {}),
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Anthropic 錯誤體:{ type: "error", error: { type, message } }。
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
        content?: { type?: string; text?: string }[];
      } | null;
      if (!body || !Array.isArray(body.content)) {
        return { ok: false, error: "anthropic: unexpected response shape" };
      }
      const text = body.content
        .filter(
          (c): c is { type: string; text: string } =>
            c?.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("");
      return { ok: true, text, model };
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

  /** generateAnthropic 的 streaming 版:同一份 body 多加 `stream: true`(system
   * 抽出邏輯與非 streaming 版完全一致)。回應為具名 SSE 事件:
   * `content_block_delta`(`delta.type==="text_delta"` 的文字片段)、
   * `message_stop`(完成)、`error`(中途錯誤,`error.message`)。 */
  private async *generateAnthropicStream(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): AsyncGenerator<AiStreamEvent> {
    const apiKey = await getSetting<string>("core.ai.apiKey", "");
    if (!apiKey) {
      yield { type: "error", error: "not_configured" };
      return;
    }
    const baseUrl =
      (await getSetting<string>("core.ai.baseUrl", "")) ||
      ANTHROPIC_DEFAULT_BASE_URL;

    const systemMessages = opts.messages.filter((m) => m.role === "system");
    const chatMessages = opts.messages.filter((m) => m.role !== "system");
    const system =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join("\n\n")
        : undefined;

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
          messages: chatMessages,
          stream: true,
          ...(system ? { system } : {}),
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        yield {
          type: "error",
          error: truncate(
            `anthropic ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
          ),
        };
        return;
      }
      if (!res.body) {
        yield { type: "error", error: "anthropic: empty stream body" };
        return;
      }

      for await (const frame of parseSseStream(res.body)) {
        if (frame.event === "message_stop") {
          yield { type: "done", model };
          return;
        }
        if (frame.event === "error") {
          const parsed = safeJsonParse<{ error?: { message?: string } }>(
            frame.data,
          );
          yield {
            type: "error",
            error: truncate(
              `anthropic${parsed?.error?.message ? `: ${parsed.error.message}` : ""}`,
            ),
          };
          return;
        }
        if (frame.event === "content_block_delta") {
          const parsed = safeJsonParse<{
            delta?: { type?: string; text?: string };
          }>(frame.data);
          if (
            parsed?.delta?.type === "text_delta" &&
            typeof parsed.delta.text === "string"
          ) {
            yield { type: "delta", text: parsed.delta.text };
          }
        }
        // 其餘事件(message_start / content_block_start / content_block_stop /
        // message_delta / ping)與文字擷取無關,略過。
      }
      // 同 openai 版:防禦性補一個 done,避免上游未送 message_stop 就斷線。
      yield { type: "done", model };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        yield { type: "error", error: "timeout" };
        return;
      }
      yield {
        type: "error",
        error: truncate(
          `anthropic network_error${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async generateWorkersAi(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): Promise<AiGenerateResult> {
    // Cloudflare `AI` binding —— 刻意不進 wrangler.jsonc(spec 明定由使用者自行加,
    // 執行期偵測)。getAI() 缺 binding 回 undefined,同 not_configured 語意
    // (不特別揭露「加 binding」提示字串,維持與其他 not_configured 分支一致;
    // 提示留在本檔與 cf.ts 的註解)。
    const ai = getAI();
    if (!ai) {
      return { ok: false, error: "not_configured" };
    }
    try {
      const result = await withTimeout(
        ai.run(model, { messages: opts.messages, max_tokens: maxTokens }),
        GENERATE_TIMEOUT_MS,
      );
      // Workers AI REST 慣例回應形狀 { response: string };防禦性讀取。
      const text = (result as { response?: unknown } | null)?.response;
      if (typeof text !== "string") {
        return { ok: false, error: "workers-ai: unexpected response shape" };
      }
      return { ok: true, text, model };
    } catch (e) {
      if (e instanceof Error && e.message === "timeout") {
        return { ok: false, error: "timeout" };
      }
      return {
        ok: false,
        error: truncate(
          `workers-ai${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      };
    }
  }

  /** generateWorkersAi 的 streaming 版。`ai.run()` 不是 fetch,沒有 AbortSignal
   * 可傳,故用 withDeadline 對單一絕對時間點逐次(取得串流本身 + 之後每個
   * reader.read())扣時,語意與 fetch 版 AbortController 一致:逾時 →
   * `{type:"error", error:"timeout"}`。依 Cloudflare Workers AI 文件,
   * `stream:true` 時 `ai.run()` 直接回傳 SSE 框的 `ReadableStream`
   * (`data: {"response":"..."}`,終止 frame 為字面 `data: [DONE]`)——與
   * openai 的 frame 形狀相同,只是欄位名不同,故沿用共用 parseSseStream。 */
  private async *generateWorkersAiStream(
    opts: AiGenerateOptions,
    model: string,
    maxTokens: number,
  ): AsyncGenerator<AiStreamEvent> {
    const ai = getAI();
    if (!ai) {
      yield { type: "error", error: "not_configured" };
      return;
    }
    const deadlineAt = Date.now() + GENERATE_TIMEOUT_MS;
    try {
      const result = await withDeadline(
        ai.run(model, {
          messages: opts.messages,
          max_tokens: maxTokens,
          stream: true,
        }),
        deadlineAt,
      );
      if (!(result instanceof ReadableStream)) {
        yield { type: "error", error: "workers-ai: unexpected response shape" };
        return;
      }

      for await (const frame of parseSseStream(
        result as ReadableStream<Uint8Array>,
        deadlineAt,
      )) {
        if (frame.data === "[DONE]") {
          yield { type: "done", model };
          return;
        }
        const parsed = safeJsonParse<{ response?: string }>(frame.data);
        if (typeof parsed?.response === "string" && parsed.response.length > 0) {
          yield { type: "delta", text: parsed.response };
        }
      }
      // 同 openai/anthropic 版:防禦性補一個 done,避免上游未送 [DONE] 就斷線。
      yield { type: "done", model };
    } catch (e) {
      if (e instanceof Error && e.message === "timeout") {
        yield { type: "error", error: "timeout" };
        return;
      }
      yield {
        type: "error",
        error: truncate(
          `workers-ai${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      };
    }
  }
}
