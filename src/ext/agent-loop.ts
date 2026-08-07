import { z } from "zod";
import {
  ASK_DESCRIPTION,
  askArgsObjectSchema,
  askArgsSchema,
} from "./agent-ask";
import type { AgentAsk } from "./agent-ask";
import { agentDisplaySchema } from "./agent-display";
import type { AgentDisplay } from "./agent-display";
import { invokeAgentTool } from "./agent-tools";
import type {
  AgentTool,
  AgentToolCtx,
  AgentToolRegistry,
} from "./agent-tools";
import { recordAgentToolRun } from "./agent-audit";
import type { Locale } from "@/lib/i18n/index";
import { toAssistantMessage } from "./providers/ai";
import type {
  AiChatContentBlock,
  AiChatMessage,
  AiChatOptions,
  AiChatResult,
  AiChatStopReason,
  AiChatStreamEvent,
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
//
// ── §4.6:反問卡(core.ui.ask)────────────────────────────────────────────────
// 缺關鍵資訊時,模型的兩條舊路都不好:猜(可能猜錯,而下一步是 write),或用一段
// 文字問完等人打字回答。第三條是本檔合成的 core.ui.ask —— 它在 tools 清單裡看起來
// 就是一個 tool,但**永遠不執行**,呼叫它的結果是一張結構化的問題卡,答案由前端
// 以 tool_result 接回 transcript 續跑。與 write 提案共用同一條攔截規則,見下面的
// haltingAssistantMessage 與 loop 內的攔截段。
//
// ── 1.32.0:過程事件(AgentLoopEvent)────────────────────────────────────────
// params.onEvent 是**唯一**的新行為開關。給了它就會邊跑邊回報(step / text_delta /
// tool / tool_done),沒給就與 1.31.0 逐位元相同。刻意做成 callback 而不是把
// runAgentChat 改成 generator:確認制的規則全寫在這一個函式的控制流裡,把它翻成
// generator 等於為了顯示層重寫安全表面。
//
// ── 1.33.0:結果卡(AgentToolCallLog.display)──────────────────────────────────
// read tool **執行成功之後**,由 tool 自己的 display() 把那份結果轉成 widget spec
// (見 agent-display.ts:呈現一律由 tool 宣告,不由模型宣告)。三條界線:
//   · 只搭最後的 outcome 走,**不進 AgentLoopEvent** —— transcript 由 outcome 組裝,
//     串流是暫態,一張畫出來又被換掉的卡片就只是閃了一下;
//   · 失敗或被截斷的結果不附卡片(見 runReadRound 內的說明);
//   · **write 提案永遠沒有卡片** —— 不是靠哪裡多寫一個 if,而是因為 write 在 loop
//     內根本不執行,沒有結果可以拿來畫(§1.2)。

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
function toJsonSchema(
  name: string,
  schema: z.ZodType,
): Record<string, unknown> {
  try {
    const raw = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "$schema"),
    );
  } catch (e) {
    // 走到這裡代表某個 tool 的 schema 用了轉不出來的構造 —— 是 bug,要看得見。
    // 但不讓它連累整輪對話:退成「任意物件」,args 仍由執行端的 zod 把關。
    console.error(`[agent-loop] cannot convert schema of "${name}"`, e);
    return { type: "object", additionalProperties: true };
  }
}

/** registry 的 tools → 餵給 LLM 的宣告。read 與 write 都在內(見檔頭)。 */
export function toAiToolDefs(tools: readonly AgentTool[]): AiToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.name, tool.schema),
  }));
}

// ---------------------------------------------------------------------------
// core.ui.ask —— 合成的反問工具(spec §4.6)
// ---------------------------------------------------------------------------

/**
 * 反問卡的 tool 名。**不註冊進 AgentToolRegistry**,由 loop 在組 tool defs 時
 * 合成附加。
 *
 * registry 的語意是「可執行的工具」:每一筆都有 kind、有 schema、有 execute,而
 * /execute 端點認得的就是那份清單。core.ui.ask 永遠不執行 —— 它不讀資料也不寫
 * 資料,它是一次對話。註冊進去等於在「可執行清單」裡放一個永遠不能執行的成員,
 * 然後在每一個消費者(/execute、slash 選單、面板的工具清單、audit)各補一條例外。
 * 合成附加則反過來:模型看得到它,而所有把 registry 當成「這個站有哪些動作」的
 * 地方自然不會列到它 —— **那是要的效果,不是漏掉的接線**。
 */
export const CORE_UI_ASK = "core.ui.ask";

// 形狀與說明在 agent-ask.ts(同層,見該檔頭)。這裡只留「什麼時候攔、攔了怎麼辦」。
export type { AgentAsk, AgentAskField, AgentAskOption } from "./agent-ask";

/** registry 的 defs + 合成的 ask。 */
function withAskTool(defs: AiToolDef[]): AiToolDef[] {
  // 理論上不可能(沒有人會去註冊一個 core.ui.* 的 tool),但真的撞名時要讓位給
  // 註冊的那一筆:它是可執行的,而合成這一筆只會讓模型呼叫到一個永遠停下來的
  // 東西。撞名本身是 bug,所以要吵。
  if (defs.some((def) => def.name === CORE_UI_ASK)) {
    console.error(
      `[agent-loop] a registered tool is named "${CORE_UI_ASK}"; the synthetic ask tool stands down`,
    );
    return defs;
  }
  return [
    ...defs,
    {
      name: CORE_UI_ASK,
      description: ASK_DESCRIPTION,
      inputSchema: toJsonSchema(CORE_UI_ASK, askArgsObjectSchema),
    },
  ];
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
  /**
   * 這筆結果的卡片式呈現(1.33.0)。由 tool 自己的 display() 產出、經
   * agentDisplaySchema 驗過;沒宣告 / 產不出來 / 驗不過 → 這個鍵不存在。
   *
   * **只搭最後的 outcome 走,不進串流事件**(AgentLoopEvent)。理由與本檔既有的
   * 串流註解一致:transcript 只由最後的 outcome 組裝,串流是暫態 —— 一張在串流
   * 中先畫出來、再被正式條目換掉的卡片,對使用者而言是同一張圖閃了一下。
   */
  display?: AgentDisplay;
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
  | (AgentOutcomeBase & {
      /**
       * 反問卡(spec §4.6)。形狀鏡射 proposal:appended 是 delta、其中的 assistant
       * 訊息只保留這一個 tool_use,而**回答與關閉兩條路都必須補一則 tool_result**
       * (前端的 applyAskResolution;懸空的 tool_use 會讓下一次 /chat 被上游拒收)。
       */
      status: "ask";
      /** 助理在反問之前說的話(可能為空字串)。 */
      text: string;
      ask: AgentAsk;
      toolUseId: string;
    })
  | (AgentOutcomeBase & { status: "max_steps"; text: string })
  | (AgentOutcomeBase & {
      status: "error";
      /** "not_configured" | "timeout" | "tool_use_not_supported" | 上游摘要。 */
      error: string;
    });

/**
 * loop 進行中的過程事件(1.32.0)。**純粹是顯示層的東西** —— outcome 的形狀、
 * transcript 的組裝、audit 都與有沒有人在聽這些事件無關。
 *
 * 為什麼要有 step/tool 而不只是 text_delta:多步 loop 的等待時間主要花在工具上,
 * 而工具期間模型一個字都不會吐。少了這兩種事件,「邊查邊講」在最需要交代的那段
 * 反而是全黑的。
 */
export type AgentLoopEvent =
  /** 第 step 步開始(1-based)。 */
  | { type: "step"; step: number }
  /** 助理正在說的字(來自 provider 的 chatStream;沒有 chatStream 時不會出現)。 */
  | { type: "text_delta"; text: string }
  /** 一個 read tool 開始執行。 */
  | { type: "tool"; name: string }
  | { type: "tool_done"; name: string; ok: boolean };

export interface AgentChatParams {
  /** 前端持有的 transcript(spec §4:server stateless)。 */
  messages: AiChatMessage[];
  system: string;
  registry: AgentToolRegistry;
  ctx: AgentToolCtx;
  /**
   * admin 介面語言,只用來挑確認卡摘要的語言(AgentTool.summarize)。省略 → "en",
   * 與 getLocale() 未設定時的回答一致 —— route 一律傳,預設值是給直接呼叫 loop 的
   * 測試與工具用的。
   */
  locale?: Locale;
  /**
   * 注入點:預設 src/lib/ai.ts 的 chatAiWithTools(dynamic import,避免把
   * loader/services 這條鏈綁進本檔的靜態相依)。測試以假 provider 取代。
   */
  chat?: (opts: AiChatOptions) => Promise<AiChatResult>;
  /**
   * 串流版的注入點(1.32.0),預設 src/lib/ai.ts 的 chatAiStreamWithTools。
   * **只有 onEvent 存在時才會被用到**;而且 `chat` 被注入、這個沒有時一律尊重
   * 注入 —— 呼叫端給了一個假 provider,不該因為多帶了 onEvent 就偷偷改打真的
   * @/lib/ai。
   */
  chatStream?: (opts: AiChatOptions) => AsyncGenerator<AiChatStreamEvent>;
  /**
   * 過程事件的接收者(1.32.0)。**省略時 loop 的行為與 1.31.0 完全相同**:
   * 走非串流 chat()、不發任何事件、outcome 一字不差。
   *
   * 這個 callback throw 會被吞掉:顯示層壞掉不准連累一輪已經在跑的對話
   * (跑到一半的 write 提案消失,比少幾行進度字嚴重得多)。
   */
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * client 斷線時中止(route 傳 request.signal)。每一步開始前檢查一次 ——
   * 沒有人在聽了就不要再往上游打第 5、6、7、8 次。已經送出的那一次上游呼叫
   * 不會被中斷(它有自己的 60s 預算),但不會再有下一次。
   */
  signal?: AbortSignal;
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
 * 一筆結果的卡片宣告(1.33.0)。**只在 tool 執行成功之後才呼叫**。
 *
 * 兩道關口,順序不能顛倒:
 *   1. try/catch 保險絲 —— 照 proposalSummary 的既有寫法。一個壞掉的 display()
 *      不該讓已經跑完的查詢消失;沒有卡片的答案仍然是答案,炸掉的一輪不是。
 *   2. agentDisplaySchema.safeParse —— 驗不過就丟掉並 console.error。**不截斷、
 *      不修補**:一張少了一半段落或畫著 NaN 的卡,比沒有卡更容易讓人讀錯數字,
 *      而使用者沒有任何線索知道它是壞的。錯要讓寫 tool 的人看見,不要讓看板的人
 *      承擔。
 */
function resolveDisplay(
  tool: AgentTool,
  result: unknown,
  locale: Locale,
): AgentDisplay | undefined {
  if (!tool.display) return undefined;
  let raw: unknown;
  try {
    raw = tool.display(result, locale);
  } catch (e) {
    console.error(`[agent-loop] "${tool.name}".display failed`, e);
    return undefined;
  }
  if (raw === undefined) return undefined;
  const parsed = agentDisplaySchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      `[agent-loop] "${tool.name}".display returned an invalid shape`,
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
    return undefined;
  }
  return parsed.data;
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
  emit: (event: AgentLoopEvent) => void,
): Promise<ReadRoundResult> {
  const blocks: AiChatContentBlock[] = [];
  const logs: AgentToolCallLog[] = [];
  let left = remaining;

  for (const use of uses) {
    emit({ type: "tool", name: use.name });
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
      emit({ type: "tool_done", name: use.name, ok: false });
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
    // 卡片只搭「成功而且完整」的結果:失敗時根本沒有資料可畫;被截斷時,模型
    // 看到的是半份資料而卡片畫的是全份,兩者並排出現只會讓人不知道該信哪一個。
    const display =
      outcome.ok && !bounded.truncated
        ? resolveDisplay(tool, outcome.result, params.locale ?? "en")
        : undefined;
    logs.push({
      toolName: tool.name,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
      truncated: bounded.truncated,
      ...(display ? { display } : {}),
    });
    emit({ type: "tool_done", name: tool.name, ok: outcome.ok });
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
 * v1 由 code 產出,不另外要 LLM 寫:再問一次模型要多一次呼叫與多一次幻覺的機會,
 * 而確認卡是整個系統唯一「admin 據以按下確認」的字。模型自己的說法不會消失 ——
 * 它在 outcome.text 裡,面板照樣渲染在卡片上方。
 *
 * 兩條路,依序:
 *   1. tool.summarize(1.31.0):作者寫的 admin 語言短句。這是**該走的**那條。
 *   2. 退回推導:description 第一句(作者寫給人看的、必定與 tool 實際做的事一致)
 *      + args 預覽(讓「動的是哪一筆」看得見)。英文,但總比沒有好。
 *
 * summarize throw 或回空白就走 (2):一個壞掉的摘要函式不該讓提案本身消失 ——
 * 沒有摘要的確認卡等於要 admin 對著一團 JSON 按確認。
 */
function proposalSummary(
  tool: AgentTool,
  input: unknown,
  locale: Locale,
): string {
  if (tool.summarize) {
    try {
      const written = tool.summarize(input, locale);
      // 回非字串也走這裡(.trim() 會 throw),與「回空字串」同樣退回推導版。
      const trimmed = written.trim();
      if (trimmed.length > 0) {
        return truncate(trimmed, PROPOSAL_SUMMARY_MAX_CHARS);
      }
    } catch (e) {
      console.error(`[agent-loop] "${tool.name}".summarize failed`, e);
    }
  }
  const firstSentence = tool.description.split(". ")[0] ?? tool.description;
  const preview = truncate(jsonText(input), PROPOSAL_ARGS_PREVIEW_MAX_CHARS);
  return truncate(
    `${firstSentence.trim()} — ${preview}`,
    PROPOSAL_SUMMARY_MAX_CHARS,
  );
}

/**
 * 停下來的那一回合的 assistant 訊息:保留文字與**被留下的那一個** tool_use,丟掉
 * 同一回合其餘的 tool_use。write 提案與 core.ui.ask 共用(兩者都是「停下來等人」)。
 *
 * 為什麼要動這則訊息:一個 tool_use 沒有對應的 tool_result,transcript 就是壞的
 * (上游拒收)。留下的那一個之後會由 /execute、「取消」、或反問卡的回答/關閉補上
 * 結果;其餘的補不了 —— 它們既沒執行也不會執行。與其留下懸空的 id,不如不要留。
 *
 * 副作用是好的:這讓 §4.5「一次只提一個 write」「一次只問一張卡」從一句 prompt 裡
 * 的請求,變成 harness 保證的性質 —— 模型不遵守也改變不了結果。
 */
function haltingAssistantMessage(
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

async function* defaultChatStream(
  opts: AiChatOptions,
): AsyncGenerator<AiChatStreamEvent> {
  const { chatAiStreamWithTools } = await import("@/lib/ai");
  yield* chatAiStreamWithTools(opts);
}

/**
 * 跑一步串流版的對話:邊轉發 text_delta,邊等最後那個 result。
 *
 * generator 的契約是「最後一個事件恆為 result」(ai-chat.ts),但這裡不假設對方
 * 守約 —— 注入進來的 chatStream 可能是第三方的。沒收到 result 就合成一個錯誤,
 * 讓 loop 走既有的 status:"error" 路徑,而不是拿一個 undefined 往下算。
 */
async function runStreamStep(
  stream: (opts: AiChatOptions) => AsyncGenerator<AiChatStreamEvent>,
  opts: AiChatOptions,
  emit: (event: AgentLoopEvent) => void,
): Promise<AiChatResult> {
  let result: AiChatResult | null = null;
  for await (const event of stream(opts)) {
    if (event.type === "text_delta") {
      emit({ type: "text_delta", text: event.text });
      continue;
    }
    result = event.result;
  }
  return result ?? { ok: false, error: "stream_ended_without_result" };
}

/**
 * 跑一輪對話(spec §4)。
 *
 *   ai.chat(messages, tools)
 *     → 純文字             → 回前端,結束
 *     → tool_use(read)    → 執行、記 audit、tool_result 接回,續 loop
 *     → tool_use(write)   → **不執行**。回提案,結束
 *     → core.ui.ask       → 不執行、不記 audit。回反問卡,結束(§4.6)
 *
 * 永不 throw:上游錯誤(含 tool_use_not_supported)一律收斂成 status:"error",
 * 錯誤碼原樣透傳給前端 —— 面板要能對「這個 mode/model 不支援工具呼叫」給出專屬提示,
 * 而不是一句通用錯誤(spec §4.5)。
 */
export async function runAgentChat(
  params: AgentChatParams,
): Promise<AgentChatOutcome> {
  const chat = params.chat ?? defaultChat;
  // 合成的 core.ui.ask 附在最後(見 CORE_UI_ASK):registry 不認得它,LLM 認得。
  const tools = withAskTool(toAiToolDefs(params.registry.list()));

  // onEvent 缺席 → emit 是 no-op、streaming 是 null,整個函式的行為與 1.31.0
  // 逐位元相同。onEvent 自己 throw 一律吞掉(見 AgentChatParams.onEvent)。
  const onEvent = params.onEvent;
  const emit = onEvent
    ? (event: AgentLoopEvent): void => {
        try {
          onEvent(event);
        } catch (e) {
          console.error("[agent-loop] onEvent threw", e);
        }
      }
    : () => {};
  const streaming = onEvent
    ? (params.chatStream ?? (params.chat ? null : defaultChatStream))
    : null;

  const appended: AiChatMessage[] = [];
  const toolCalls: AgentToolCallLog[] = [];
  let transcript: AiChatMessage[] = [...params.messages];
  let remaining = TOOL_RESULT_ROUND_MAX_CHARS;
  let lastText = "";

  for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
    if (params.signal?.aborted) {
      // client 走了。回一個誠實的 outcome(沒有人會讀到它)而不是繼續燒上游額度。
      return {
        status: "error",
        error: "aborted",
        appended,
        steps: step - 1,
        toolCalls,
      };
    }
    emit({ type: "step", step });

    const opts: AiChatOptions = {
      messages: transcript,
      tools,
      system: params.system,
      maxTokens: AGENT_MAX_TOKENS,
    };
    const res = streaming
      ? await runStreamStep(streaming, opts, emit)
      : await chat(opts);

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

    // ── 攔截:這一輪的第一個「非 read」 ──────────────────────────────────
    //
    // write → 確認卡(鐵律:write 永不在 loop 內執行);core.ui.ask → 反問卡。
    // 兩者都是「停下來等人」,所以共用一條規則:**依 block 順序**先出現的那一個
    // 勝出,同回合其餘的 tool_use 一律丟棄(haltingAssistantMessage)。
    //
    // 依順序而不是「write 優先」是刻意的:模型在同一回合先問後寫時,該先送到
    // admin 面前的是那個問題 —— 它連自己要寫什麼都還沒確定。
    const halting = uses.find(
      (use) =>
        use.name === CORE_UI_ASK ||
        params.registry.get(use.name)?.kind === "write",
    );

    if (halting && halting.name === CORE_UI_ASK) {
      const parsed = askArgsSchema.safeParse(halting.input);
      const assistantMessage = haltingAssistantMessage(assistant, halting.id);
      if (parsed.success) {
        // 不執行任何東西、不記 audit:這是一次對話,不是一次資料存取。答案本來
        // 就會以 tool_result 的形式進 transcript,而 transcript 是使用者自己的。
        return {
          status: "ask",
          text: lastText,
          ask: parsed.data,
          toolUseId: halting.id,
          appended: [...appended, assistantMessage],
          steps: step,
          toolCalls,
          model: res.model,
        };
      }

      // 送壞了 → 錯誤摘要包成 tool_result 接回、續 loop(§4.5 的 harness 紀律:
      // 模型看得到自己送壞了才會改)。不把它丟給前端 —— 一張畫不出來的卡片對
      // admin 而言就是「助理沒有反應」。
      const bounded = boundedResult(
        jsonText({
          error: "invalid_args",
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        }),
        remaining,
      );
      remaining -= bounded.used;
      const resultMessage: AiChatMessage = {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: halting.id,
            content: bounded.content,
            isError: true,
          },
        ],
      };
      // toolCalls 也記一筆。這不是 audit(什麼都沒執行,agent_audit 不會多一列),
      // 是**渲染條目的對位**:面板依「一則訊息裡有幾個 tool_result 就吃幾筆 log」
      // 對位(transcript.ts 的 foldAppended),這裡少記一筆,後面每一輪的工具名
      // 都會整組錯位。
      toolCalls.push({
        toolName: CORE_UI_ASK,
        ok: false,
        error: "invalid_args",
        truncated: bounded.truncated,
      });
      appended.push(assistantMessage, resultMessage);
      transcript = [...transcript, assistantMessage, resultMessage];
      continue;
    }

    if (halting) {
      const tool = params.registry.get(halting.name);
      return {
        status: "proposal",
        text: lastText,
        proposal: {
          toolName: halting.name,
          toolUseId: halting.id,
          args: halting.input,
          // tool 必定存在(halting 走到這裡是從 registry 查到 kind:"write" 才選出
          // 來的);型別上仍可能是 null,退回 tool 名讓摘要不至於空白。
          summary: tool
            ? proposalSummary(tool, halting.input, params.locale ?? "en")
            : halting.name,
        },
        appended: [...appended, haltingAssistantMessage(assistant, halting.id)],
        steps: step,
        toolCalls,
        model: res.model,
      };
    }

    const round = await runReadRound(uses, params, remaining, emit);
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
