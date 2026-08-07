import { z } from "zod";
import { invokeAgentTool } from "./agent-tools";
import type {
  AgentTool,
  AgentToolCtx,
  AgentToolRegistry,
} from "./agent-tools";
import { recordAgentToolRun } from "./agent-audit";
import { toAssistantMessage } from "./providers/ai";
import type {
  AiChatContentBlock,
  AiChatMessage,
  AiChatOptions,
  AiChatResult,
  AiChatStopReason,
  AiChatToolUse,
  AiToolDef,
} from "./providers/ai";

// docs/spec-admin-agent.md §4 + §4.5:agent loop 的本體。
//
// 這一層是**確認制的守門層**。整份 spec 的安全主張最後收斂成本檔的一條分支:
// 助理要求呼叫一個 kind:"write" 的 tool 時,這裡回一個提案並結束,而不是執行它。
// 沒有旗標、沒有參數、沒有設定可以走到另一條路 —— 那條路在程式碼裡不存在
// (§1.2:「自動核可不是預設關閉,是不存在的功能」)。
//
// ── 為什麼 loop 與 route 分開 ───────────────────────────────────────────────
// route 負責 guard(same-origin / admin / rate limit / body 上限)與接線;本檔負責
// 「LLM 說了什麼 → 站上發生什麼」的規則。分開是因為守門測試要能直接餵一個假的
// AiProvider 回應,而不必先組出一個 HTTP request、一份 session、一組 header。
// registry 與 services 由呼叫端注入(route 一律經 buildAgentToolRegistry,見
// agent-tools-runtime.ts)—— 注入點也讓測試能放一個「execute 被呼叫就會被看見」
// 的替身進來,那是鐵律測試唯一誠實的寫法。
//
// ── 給 LLM 的 tools 是全部,read 與 write 都給 ────────────────────────────────
// 這與 agent-tools.ts 註解裡「loop 只拿 list("read")」的字面說法不同,值得寫清楚:
// 那句話講的是**執行面**(loop 內不執行 write),而不是**可見面**。write tool 若對
// LLM 不可見,它就沒有辦法提案,確認制也就沒有東西可以確認 —— 整個面板會退化成
// 一個唯讀的問答機。正確的語意是:**write 看得到、永不執行**。
// 「永不執行」由下面 runAgentChat 的 proposal 分支保證,不由 tools 清單保證。

/** 步數上限(spec §4)。到頂回明確狀態,不是靜默停止。 */
export const AGENT_MAX_STEPS = 8;
/** 每次 chat 呼叫的 maxTokens。Phase B 預設 1024 對帶工具的 loop 偏緊。 */
export const AGENT_MAX_TOKENS = 4096;
/** 單筆 tool_result 上限(字元,spec §4.5)。 */
export const TOOL_RESULT_MAX_CHARS = 4_000;
/** 整輪(一次 /chat 請求內所有 tool_result 的總和)上限(字元,spec §4.5)。 */
export const TOOL_RESULT_ROUND_MAX_CHARS = 16_000;
/** 提案摘要上限。 */
const PROPOSAL_SUMMARY_MAX_CHARS = 300;
/** 提案摘要裡的參數預覽上限。 */
const PROPOSAL_ARGS_PREVIEW_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// tools → JSON Schema
// ---------------------------------------------------------------------------

/**
 * zod → JSON Schema。zod 4 內建 `z.toJSONSchema()`,Phase A 的所有 schema 都避開了
 * pipe/transform,故無需自訂轉換器。
 *
 * `io:"input"` 是刻意的:餵給 LLM 的是它要**送進來**的形狀。`unrepresentable:"any"`
 * 讓表達不出來的節點退成 `{}`(接受任意值)而不是整份轉換失敗 —— 少一個型別約束的
 * 代價是模型可能送壞,而那由執行端的 zod 擋下並回報;整份轉換失敗的代價是這個
 * tool 對 LLM 消失,而且沒有任何錯誤訊息。
 *
 * `$schema` 濾掉:三家上游都不需要它,而某些 OpenAI-compatible 代理對未知頂層鍵
 * 會直接拒絕整份請求。
 */
function toJsonSchema(tool: AgentTool): Record<string, unknown> {
  try {
    const raw = z.toJSONSchema(tool.schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "$schema"),
    );
  } catch (e) {
    // 走到這裡代表某個 tool 的 schema 用了轉不出來的構造 —— 是 bug,要看得見。
    // 但不讓它連累整輪對話:退成「任意物件」,args 仍由執行端的 zod 把關。
    console.error(`[agent-loop] cannot convert schema of "${tool.name}"`, e);
    return { type: "object", additionalProperties: true };
  }
}

/** registry 的 tools → 餵給 LLM 的宣告。read 與 write 都在內(見檔頭)。 */
export function toAiToolDefs(tools: readonly AgentTool[]): AiToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool),
  }));
}

// ---------------------------------------------------------------------------
// 對外形狀
// ---------------------------------------------------------------------------

/** 待人工確認的 write 提案(spec §4)。 */
export interface AgentProposal {
  toolName: string;
  /**
   * 對應的 tool_use.id。前端在 /execute(或取消)之後必須以這個 id 補一則
   * tool_result 接回 transcript —— 少了它,下一次 /chat 送出的就是一份帶著懸空
   * tool_use 的對話,上游會直接拒收。
   */
  toolUseId: string;
  args: unknown;
  /** 人話摘要(確認卡標題用)。 */
  summary: string;
}

/** 這一輪實際跑過的 tool(給面板的「工具呼叫」摺疊區用)。 */
export interface AgentToolCallLog {
  toolName: string;
  ok: boolean;
  /** 失敗時的摘要(已截斷)。 */
  error?: string;
  /** result 是否因為上限被截斷(截斷本身也標注在 tool_result 內文裡)。 */
  truncated: boolean;
}

interface AgentOutcomeBase {
  /** 本輪**新增**的訊息(delta,非完整 transcript)。前端接在自己那份後面。 */
  appended: AiChatMessage[];
  /** 實際跑了幾步(每步 = 一次 LLM 呼叫)。 */
  steps: number;
  toolCalls: AgentToolCallLog[];
  model?: string;
}

export type AgentChatOutcome =
  | (AgentOutcomeBase & {
      status: "text";
      text: string;
      stopReason?: AiChatStopReason;
    })
  | (AgentOutcomeBase & {
      status: "proposal";
      /** 助理在提案之前說的話(可能為空字串)。 */
      text: string;
      proposal: AgentProposal;
    })
  | (AgentOutcomeBase & { status: "max_steps"; text: string })
  | (AgentOutcomeBase & {
      status: "error";
      /** "not_configured" | "timeout" | "tool_use_not_supported" | 上游摘要。 */
      error: string;
    });

export interface AgentChatParams {
  /** 前端持有的 transcript(spec §4:server stateless)。 */
  messages: AiChatMessage[];
  system: string;
  registry: AgentToolRegistry;
  ctx: AgentToolCtx;
  /**
   * 注入點:預設 src/lib/ai.ts 的 chatAiWithTools(dynamic import,避免把
   * loader/services 這條鏈綁進本檔的靜態相依)。測試以假 provider 取代。
   */
  chat?: (opts: AiChatOptions) => Promise<AiChatResult>;
}

// ---------------------------------------------------------------------------
// tool_result 組裝
// ---------------------------------------------------------------------------

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return '"[unserializable result]"';
  }
}

interface BoundedText {
  content: string;
  truncated: boolean;
  /** 這一筆實際佔用的整輪預算。 */
  used: number;
}

/**
 * 把一筆結果收進上限內(spec §4.5:單筆與整輪各一個上限,超限截斷並標注)。
 *
 * 標注是重點,不是禮貌:模型看不到自己收到的是半份資料時,會把「列表只有三筆」
 * 當成事實,然後基於那個事實提案。
 */
function boundedResult(raw: string, remaining: number): BoundedText {
  if (remaining <= 0) {
    return {
      content:
        "[omitted: this turn's tool-result budget is used up. Ask for less data — a narrower search or a smaller page — and try again.]",
      truncated: true,
      used: 0,
    };
  }
  const limit = Math.min(TOOL_RESULT_MAX_CHARS, remaining);
  if (raw.length <= limit) return { content: raw, truncated: false, used: raw.length };
  return {
    content: `${raw.slice(0, limit)}\n…[truncated: showing ${limit} of ${raw.length} characters. Narrow the query or fetch a single entry to see the rest.]`,
    truncated: true,
    used: limit,
  };
}

interface ReadRoundResult {
  blocks: AiChatContentBlock[];
  logs: AgentToolCallLog[];
  remaining: number;
}

/**
 * 執行這一輪的所有 read tool_use,組出對應的 tool_result blocks。
 *
 * 全部塞進**同一則** user 訊息:上游(尤其 anthropic)要求一個 assistant 回合裡的
 * 每個 tool_use 都在緊接的那一則 user 訊息裡有對應的 tool_result。拆成多則會被
 * 判為格式錯誤。
 *
 * 失敗不中斷(spec §4.5):錯誤摘要當 tool_result 回給 LLM 續跑 —— 模型看得到失敗
 * 才會換路,而中斷整輪只會讓 admin 看到一個沒頭沒尾的錯誤。
 */
async function runReadRound(
  uses: readonly AiChatToolUse[],
  params: AgentChatParams,
  remaining: number,
): Promise<ReadRoundResult> {
  const blocks: AiChatContentBlock[] = [];
  const logs: AgentToolCallLog[] = [];
  let left = remaining;

  for (const use of uses) {
    const tool = params.registry.get(use.name);
    if (!tool) {
      // 幻覺出來的 tool 名。不記 audit(什麼都沒執行),但要讓模型看見。
      const bounded = boundedResult(
        jsonText({ error: "unknown_tool", name: use.name }),
        left,
      );
      left -= bounded.used;
      blocks.push({
        type: "tool_result",
        toolUseId: use.id,
        content: bounded.content,
        isError: true,
      });
      logs.push({
        toolName: use.name,
        ok: false,
        error: "unknown_tool",
        truncated: false,
      });
      continue;
    }

    const outcome = await invokeAgentTool(tool, params.ctx, use.input);
    // spec §1.3:read 也記。agent 讀得到站上所有內容,「查了什麼」與「改了什麼」
    // 是同一個問題的兩半。
    await recordAgentToolRun({
      actor: params.ctx.user,
      toolName: tool.name,
      kind: tool.kind,
      source: "chat",
      args: use.input,
      outcome,
    });

    const bounded = boundedResult(
      outcome.ok
        ? jsonText(outcome.result)
        : jsonText({ error: outcome.error, issues: outcome.issues }),
      left,
    );
    left -= bounded.used;
    blocks.push({
      type: "tool_result",
      toolUseId: use.id,
      content: bounded.content,
      // 成功時不帶這個鍵(而不是帶 false):tool_result 是要送回上游的線上形狀,
      // 少一個可有可無的欄位少一分與某個 provider 不相容的機會。
      ...(outcome.ok ? {} : { isError: true }),
    });
    logs.push({
      toolName: tool.name,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
      truncated: bounded.truncated,
    });
  }

  return { blocks, logs, remaining: left };
}

// ---------------------------------------------------------------------------
// 提案
// ---------------------------------------------------------------------------

function truncate(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * 確認卡的人話摘要。
 *
 * v1 由 code 推導,不另外要 LLM 產生:再問一次模型要多一次呼叫與多一次幻覺的機會,
 * 而確認卡是整個系統唯一「admin 據以按下確認」的字。tool description 的第一句是
 * 作者寫給人看的、必定與該 tool 實際做的事一致;參數預覽讓「動的是哪一筆」看得見。
 * 模型自己的說法不會消失 —— 它在 outcome.text 裡,面板照樣渲染在卡片上方。
 */
function proposalSummary(tool: AgentTool, input: unknown): string {
  const firstSentence = tool.description.split(". ")[0] ?? tool.description;
  const preview = truncate(jsonText(input), PROPOSAL_ARGS_PREVIEW_MAX_CHARS);
  return truncate(
    `${firstSentence.trim()} — ${preview}`,
    PROPOSAL_SUMMARY_MAX_CHARS,
  );
}

/**
 * 提案回合的 assistant 訊息:保留文字與**被提案的那一個** tool_use,丟掉同一回合
 * 其餘的 tool_use。
 *
 * 為什麼要動這則訊息:一個 tool_use 沒有對應的 tool_result,transcript 就是壞的
 * (上游拒收)。提案的那一個之後會由 /execute 或「取消」補上結果;其餘的補不了 ——
 * 它們既沒執行也不會執行。與其留下懸空的 id,不如不要留。
 *
 * 副作用是好的:這讓 §4.5「一次只提一個 write」從一句 prompt 裡的請求,變成 harness
 * 保證的性質 —— 模型不遵守也改變不了結果。
 */
function proposalAssistantMessage(
  assistant: AiChatMessage,
  keepToolUseId: string,
): AiChatMessage {
  return {
    role: "assistant",
    content: assistant.content.filter(
      (block) => block.type !== "tool_use" || block.id === keepToolUseId,
    ),
  };
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

async function defaultChat(opts: AiChatOptions): Promise<AiChatResult> {
  // dynamic import:@/lib/ai 靜態相依 loader → interpret → next/navigation,
  // 靜態拉進來會讓本檔(與它的測試)在 workers pool 載不起來。
  const { chatAiWithTools } = await import("@/lib/ai");
  return chatAiWithTools(opts);
}

/**
 * 跑一輪對話(spec §4)。
 *
 *   ai.chat(messages, tools)
 *     → 純文字            → 回前端,結束
 *     → tool_use(read)   → 執行、記 audit、tool_result 接回,續 loop
 *     → tool_use(write)  → **不執行**。回提案,結束
 *
 * 永不 throw:上游錯誤(含 tool_use_not_supported)一律收斂成 status:"error",
 * 錯誤碼原樣透傳給前端 —— 面板要能對「這個 mode/model 不支援工具呼叫」給出專屬提示,
 * 而不是一句通用錯誤(spec §4.5)。
 */
export async function runAgentChat(
  params: AgentChatParams,
): Promise<AgentChatOutcome> {
  const chat = params.chat ?? defaultChat;
  const tools = toAiToolDefs(params.registry.list());

  const appended: AiChatMessage[] = [];
  const toolCalls: AgentToolCallLog[] = [];
  let transcript: AiChatMessage[] = [...params.messages];
  let remaining = TOOL_RESULT_ROUND_MAX_CHARS;
  let lastText = "";

  for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
    const res = await chat({
      messages: transcript,
      tools,
      system: params.system,
      maxTokens: AGENT_MAX_TOKENS,
    });

    if (!res.ok) {
      return {
        status: "error",
        error: res.error ?? "unknown_error",
        appended,
        steps: step,
        toolCalls,
      };
    }

    const assistant = toAssistantMessage(res);
    const uses = res.toolUses ?? [];
    lastText = res.text ?? "";

    if (uses.length === 0) {
      return {
        status: "text",
        text: lastText,
        appended: [...appended, assistant],
        steps: step,
        toolCalls,
        model: res.model,
        ...(res.stopReason ? { stopReason: res.stopReason } : {}),
      };
    }

    // ── 鐵律:write 永不在 loop 內執行 ────────────────────────────────────
    const writeUse = uses.find(
      (use) => params.registry.get(use.name)?.kind === "write",
    );
    if (writeUse) {
      const tool = params.registry.get(writeUse.name);
      return {
        status: "proposal",
        text: lastText,
        proposal: {
          toolName: writeUse.name,
          toolUseId: writeUse.id,
          args: writeUse.input,
          // tool 必定存在(writeUse 是從 registry 查到 kind 才選出來的);
          // 型別上仍可能是 null,退回 tool 名讓摘要不至於空白。
          summary: tool ? proposalSummary(tool, writeUse.input) : writeUse.name,
        },
        appended: [...appended, proposalAssistantMessage(assistant, writeUse.id)],
        steps: step,
        toolCalls,
        model: res.model,
      };
    }

    const round = await runReadRound(uses, params, remaining);
    remaining = round.remaining;
    toolCalls.push(...round.logs);
    const resultMessage: AiChatMessage = { role: "user", content: round.blocks };
    appended.push(assistant, resultMessage);
    transcript = [...transcript, assistant, resultMessage];
  }

  // 步數到頂(spec §4.5:回目前進度 + 明說)。
  return {
    status: "max_steps",
    text: lastText,
    appended,
    steps: AGENT_MAX_STEPS,
    toolCalls,
  };
}
