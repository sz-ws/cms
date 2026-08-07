import { getSetting } from "@/lib/settings";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_VERSION,
  GENERATE_TIMEOUT_MS,
  OPENAI_DEFAULT_BASE_URL,
  parseSseStream,
  safeJsonParse,
  truncate,
} from "./ai-shared";
import {
  anthropicUsage,
  mergeUsage,
  normalizeStopReason,
  openAiUsage,
  parseToolArguments,
  toAnthropicBlock,
  toOpenAiMessages,
  toWireChat,
} from "./ai-chat";
import type {
  AiChatOptions,
  AiChatStreamEvent,
  AiChatToolUse,
  AiChatUsage,
} from "./ai-chat";

// ai:generate v1.2.1 —— tool-calling streaming(CORE_API 1.32.0,
// docs/spec-admin-agent.md §3)。
//
// ── 為什麼是獨立一檔 ────────────────────────────────────────────────────────
// ai-chat.ts 已近 650 行,兩家的 SSE 狀態機再塞進去會破 800 行上限;而這裡與那裡
// 的關係不是「複製一份改成串流」—— **所有會影響結果的規則都從 ai-chat.ts import**
// (toWireChat / toOpenAiMessages / toAnthropicBlock / normalizeStopReason /
// parseToolArguments)。本檔只多做一件事:把逐塊到達的片段拼回「一次完整回應」的
// 形狀,然後交給那些同一份規則算出 AiChatResult。
//
// 這是 spec 的硬要求,不是潔癖:**串流與非串流對同一個上游回應必須算出完全一致的
// AiChatResult**。前端的 transcript 是由 result 組裝的(delta 只是暫態顯示),兩條路
// 分岔的後果是「畫面上看到的」與「送回上游續談的」不是同一段對話。
//
// ── 錯誤紀律(與 chat() 一字不差)────────────────────────────────────────────
// generator **永不 throw**。上游 4xx/5xx、逾時(GENERATE_TIMEOUT_MS 是整輪的預算,
// 不是每個 chunk 的)、讀到一半斷線,全部收斂成最後一個
// `{type:"result", result:{ok:false, error}}` 事件。錯誤摘要截 200 字、絕不含
// apiKey。已經 yield 過的 text_delta 不收回 —— 那些字確實從上游來過。
//
// ── workers-ai 不在這裡 ─────────────────────────────────────────────────────
// 見 ai.ts 的 CoreAiProvider.chatStream:它退回呼叫一次非串流 chatWorkersAi 並包成
// 單一 result 事件。
//
// ── usage(1.34.0)───────────────────────────────────────────────────────────
// 串流的 token 數不會自己來,兩家各有各的取法,而且都在「內容」以外的地方:
//   · openai —— 必須在 request 主動要(`stream_options.include_usage`),它才會在
//     **最後一個 chunk**(`[DONE]` 之前)送一個 `choices: []` 但帶 usage 的 frame;
//   · anthropic —— 預設就送,但分成兩半:`message_start` 帶 input、`message_delta`
//     帶**累積的** output。兩個都要收,而且後到的 output 覆蓋先到的(mergeUsage)。
// 解析器一律用 ai-chat.ts 那份(openAiUsage / anthropicUsage),不在本檔另寫。
// 收不到就不填 —— 沒有任何一條路徑會補 0(見 AiChatUsage 的說明)。

/** 上游還沒送出任何 result 就結束(既沒有 [DONE]/message_stop、也沒有錯誤)。
 *  防禦性:呼叫端的契約是「最後一個事件恆為 result」,少一個就會卡住。 */
const EMPTY_STREAM_ERROR = "empty stream";

// ---------------------------------------------------------------------------
// openai mode
// ---------------------------------------------------------------------------

/** 一次 tool call 的累積狀態。openai 的 SSE 以 `index` 為聚合鍵:id 與
 *  function.name 通常只在該 index 的**第一塊**出現,arguments 則是逐塊串接的
 *  JSON 字串片段。 */
interface OpenAiToolCallAcc {
  index: number;
  id: string;
  name: string;
  args: string;
}

interface OpenAiStreamDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

/** chatOpenAi 的 streaming 版:同一份 request body 多加 `stream: true`。 */
export async function* chatOpenAiStream(
  source: AiChatOptions,
  model: string,
  maxTokens: number,
): AsyncGenerator<AiChatStreamEvent> {
  const wire = toWireChat(source);
  const opts = wire.opts;
  const apiKey = await getSetting<string>("core.ai.apiKey", "");
  if (!apiKey) {
    yield { type: "result", result: { ok: false, error: "not_configured" } };
    return;
  }
  const baseUrl =
    (await getSetting<string>("core.ai.baseUrl", "")) || OPENAI_DEFAULT_BASE_URL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    // 1.34.0:串流預設**不回** usage,要主動要(`stream_options.include_usage`)。
    // 它是 OpenAI 官方 API 的一部分,但這個站接的是**任意 OpenAI-compatible 端點**
    // ——而那些代理對不認得的頂層鍵的反應是「整份 400」,不是忽略。2026-08-07 的點
    // 分 tool name 事故就是同一類:上游規則只有打到真的上游才知道。
    //
    // 所以這裡的取捨寫死:**用量是加分,對話是本分**。第一次帶著要,被 400/422 擋
    // 下來就原封不動重送一次不帶的 —— 退化的後果從「整個對話壞掉」變成「這一輪沒
    // 有用量數字」。只認這兩個碼:401/403/429 與欄位無關,重送只是多花一次錢。
    const send = (includeUsage: boolean): Promise<Response> =>
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: toOpenAiMessages(opts),
          max_tokens: maxTokens,
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
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

    let res = await send(true);
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      res = await send(false);
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      yield {
        type: "result",
        result: {
          ok: false,
          error: truncate(
            `openai ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
          ),
        },
      };
      return;
    }
    if (!res.body) {
      yield {
        type: "result",
        result: { ok: false, error: "openai: empty stream body" },
      };
      return;
    }

    let text = "";
    let finishReason: string | undefined;
    let sawAnything = false;
    let usage: AiChatUsage | undefined;
    // Map 而不是陣列:index 不保證從 0 連續(代理會跳號),也不保證按序抵達。
    const calls = new Map<number, OpenAiToolCallAcc>();

    for await (const frame of parseSseStream(res.body)) {
      if (frame.data === "[DONE]") {
        sawAnything = true;
        break;
      }
      const parsed = safeJsonParse<{
        choices?: { delta?: OpenAiStreamDelta; finish_reason?: string | null }[];
        usage?: unknown;
      }>(frame.data);
      // usage 要在 choice 檢查**之前**讀:帶 usage 的那個 chunk 的 `choices` 是
      // 空陣列,下面那行 `if (!choice) continue` 會把它整個跳過。
      usage = mergeUsage(usage, openAiUsage(parsed?.usage));
      const choice = parsed?.choices?.[0];
      // 只有 usage、沒有 choice 的那個 chunk 刻意**不算** sawAnything:一次連
      // 一個字都沒吐、只回了「你用了 N 個 token」的串流仍然是一次失敗的回合,
      // 不該因為多了這個欄位而變成一個空的 ok:true。
      if (!choice) continue;
      sawAnything = true;
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }

      const content = choice.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        text += content;
        yield { type: "text_delta", text: content };
      }

      for (const raw of choice.delta?.tool_calls ?? []) {
        // index 缺席時退回目前累積的筆數 —— 少數代理只在單一 tool call 時省略它。
        const index = typeof raw.index === "number" ? raw.index : calls.size;
        const acc = calls.get(index) ?? { index, id: "", name: "", args: "" };
        if (typeof raw.id === "string" && raw.id.length > 0) acc.id = raw.id;
        if (typeof raw.function?.name === "string" && raw.function.name.length > 0) {
          // 串接而不是覆寫:name 理論上只來一次,但真的分塊時覆寫會只剩最後一塊。
          acc.name += raw.function.name;
        }
        if (typeof raw.function?.arguments === "string") {
          acc.args += raw.function.arguments;
        }
        calls.set(index, acc);
      }
    }

    if (!sawAnything) {
      // 連線成功但一個可用的 frame 都沒有。回錯誤而不是空的 ok:true —— 空成功會
      // 讓 loop 以為模型「什麼都不想說」而正常收尾,把一次上游故障說成一次沉默。
      // (相對地,已經收到內容之後才斷的串流仍算 ok:true:那些字確實來過,
      //  stopReason 會落在 "other",呼叫端看得出來它沒有正常收尾。)
      yield {
        type: "result",
        result: { ok: false, error: `openai: ${EMPTY_STREAM_ERROR}` },
      };
      return;
    }

    // 非串流版由 `.filter(c => typeof c.id === "string" && typeof c.function.name
    // === "string")` 把殘缺的 call 濾掉;這裡的等價判準是「兩者都真的收到過」。
    const toolUses: AiChatToolUse[] = [...calls.values()]
      .sort((a, b) => a.index - b.index)
      .filter((c) => c.id.length > 0 && c.name.length > 0)
      .map((c) => ({
        id: c.id,
        name: wire.fromWire(c.name),
        input: parseToolArguments(c.args),
      }));

    yield {
      type: "result",
      result: {
        ok: true,
        text,
        toolUses,
        stopReason: normalizeStopReason(
          finishReason,
          toolUses.length > 0,
          ["length"],
          ["stop"],
        ),
        model,
        ...(usage ? { usage } : {}),
      },
    };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      yield { type: "result", result: { ok: false, error: "timeout" } };
      return;
    }
    yield {
      type: "result",
      result: {
        ok: false,
        error: truncate(
          `openai network_error${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// anthropic mode
// ---------------------------------------------------------------------------

/** 一個 content block 的累積狀態,以 SSE 的 `index` 為鍵。text 與 tool_use 共用
 *  同一張表,因為最終的 text 要**依 index 排序後串接**才與非串流版
 *  (`content.filter(type==="text").join("")`,即陣列順序)一致。 */
type AnthropicBlockAcc =
  | { kind: "text"; index: number; text: string }
  | { kind: "tool_use"; index: number; id: string; name: string; json: string };

interface AnthropicStreamData {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  /** message_start 的 payload。usage 在**這裡面**(不是頂層),帶 input_tokens。 */
  message?: { usage?: unknown };
  /** message_delta 的 usage 在頂層,帶累積的 output_tokens。 */
  usage?: unknown;
  error?: { message?: string };
}

/** chatAnthropic 的 streaming 版:同一份 request body 多加 `stream: true`。 */
export async function* chatAnthropicStream(
  source: AiChatOptions,
  model: string,
  maxTokens: number,
): AsyncGenerator<AiChatStreamEvent> {
  const wire = toWireChat(source);
  const opts = wire.opts;
  const apiKey = await getSetting<string>("core.ai.apiKey", "");
  if (!apiKey) {
    yield { type: "result", result: { ok: false, error: "not_configured" } };
    return;
  }
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
        stream: true,
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
      yield {
        type: "result",
        result: {
          ok: false,
          error: truncate(
            `anthropic ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`,
          ),
        },
      };
      return;
    }
    if (!res.body) {
      yield {
        type: "result",
        result: { ok: false, error: "anthropic: empty stream body" },
      };
      return;
    }

    const blocks = new Map<number, AnthropicBlockAcc>();
    let stopReason: string | undefined;
    let upstreamError: string | null = null;
    let stopped = false;
    let usage: AiChatUsage | undefined;

    for await (const frame of parseSseStream(res.body)) {
      const data = safeJsonParse<AnthropicStreamData>(frame.data);
      // 事件名優先取 SSE 的 `event:` 行;缺席時退回 payload 自帶的 `type`
      // —— Anthropic 兩者都送,代理只保其一的情況實際存在。
      const kind = frame.event ?? data?.type;
      if (!kind) continue;

      if (kind === "message_stop") {
        stopped = true;
        break;
      }
      if (kind === "error") {
        upstreamError = truncate(
          `anthropic${data?.error?.message ? `: ${data.error.message}` : ""}`,
        );
        break;
      }
      if (kind === "message_start") {
        // input_tokens 只在這裡出現一次(1.34.0)。這個事件在 1.33.0 之前是被
        // 略過的 —— 現在它有內容要收,見檔頭的 usage 段。
        usage = mergeUsage(usage, anthropicUsage(data?.message?.usage));
        continue;
      }
      if (kind === "message_delta") {
        if (typeof data?.delta?.stop_reason === "string") {
          stopReason = data.delta.stop_reason;
        }
        // output_tokens 是**累積值**,所以覆蓋而非相加(mergeUsage);這個事件在
        // 一次回應裡可能出現多次,只有最後一個算數。
        usage = mergeUsage(usage, anthropicUsage(data?.usage));
        continue;
      }
      if (typeof data?.index !== "number") continue;
      const index = data.index;

      if (kind === "content_block_start") {
        const type = data.content_block?.type;
        if (type === "text") {
          blocks.set(index, { kind: "text", index, text: "" });
        } else if (type === "tool_use") {
          blocks.set(index, {
            kind: "tool_use",
            index,
            id: typeof data.content_block?.id === "string" ? data.content_block.id : "",
            name:
              typeof data.content_block?.name === "string"
                ? data.content_block.name
                : "",
            json: "",
          });
        }
        continue;
      }

      if (kind === "content_block_delta") {
        const delta = data.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          const acc = blocks.get(index);
          // content_block_start 沒到就先收到 delta(代理省略):補一個空 text 塊,
          // 寧可多渲染也不要靜默丟字。
          const next: AnthropicBlockAcc =
            acc?.kind === "text" ? acc : { kind: "text", index, text: "" };
          next.text += delta.text;
          blocks.set(index, next);
          if (delta.text.length > 0) yield { type: "text_delta", text: delta.text };
        } else if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const acc = blocks.get(index);
          if (acc?.kind === "tool_use") {
            acc.json += delta.partial_json;
            blocks.set(index, acc);
          }
          // tool_use 的 start 沒到就沒有 id/name,拼出參數也無處可放 —— 丟棄,
          // 讓它走與非串流版「殘缺的 block 被濾掉」相同的結局。
        }
        continue;
      }
      // content_block_stop / ping 與結果無關:tool_use 的 JSON 一律等整段收完再
      // parse(見下),不必在 stop 事件上提早做一次。(message_start 自 1.34.0
      // 起有事要做 —— 它帶 input_tokens,已在上面攔下。)
    }

    if (upstreamError) {
      yield { type: "result", result: { ok: false, error: upstreamError } };
      return;
    }
    if (!stopped && blocks.size === 0) {
      // 沒有 message_stop、也沒有任何內容:上游斷在開頭。回錯誤而不是一個空的
      // ok:true —— 空成功會讓 loop 以為模型「什麼都不想說」而正常收尾。
      yield {
        type: "result",
        result: { ok: false, error: `anthropic: ${EMPTY_STREAM_ERROR}` },
      };
      return;
    }

    const ordered = [...blocks.values()].sort((a, b) => a.index - b.index);
    const text = ordered
      .filter((b): b is Extract<AnthropicBlockAcc, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("");
    const toolUses: AiChatToolUse[] = ordered
      .filter(
        (b): b is Extract<AnthropicBlockAcc, { kind: "tool_use" }> =>
          b.kind === "tool_use" && b.id.length > 0 && b.name.length > 0,
      )
      .map((b) => ({
        id: b.id,
        name: wire.fromWire(b.name),
        // 非串流版拿到的是已經是物件的 input(缺席 → {});串接起來的 JSON 字串經
        // 同一支 parseToolArguments 還原:空字串 → {},parse 失敗 → 原樣留字串
        // (讓執行端的 zod 報「expected object」,模型看得見自己送壞了)。
        input: parseToolArguments(b.json),
      }));

    yield {
      type: "result",
      result: {
        ok: true,
        text,
        toolUses,
        stopReason: normalizeStopReason(
          stopReason,
          toolUses.length > 0,
          ["max_tokens"],
          ["end_turn", "stop_sequence"],
        ),
        model,
        ...(usage ? { usage } : {}),
      },
    };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      yield { type: "result", result: { ok: false, error: "timeout" } };
      return;
    }
    yield {
      type: "result",
      result: {
        ok: false,
        error: truncate(
          `anthropic network_error${e instanceof Error ? `: ${e.message}` : ""}`,
        ),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
