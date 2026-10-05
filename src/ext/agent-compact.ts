// 對話太長時把較早的部分整理成一段摘要(1.71.0)。
//
// transcript 住在管理員的瀏覽器裡、每次 /chat 整份送來(spec §4:server stateless)。對話一直接下去,
// 它只會變長:每一步的 token 越來越多,最後撞上 /chat 的則數上限,那一段對話就再也送不出去。
// 所以在 loop 開跑之前先看長度:超過門檻就把「最近幾則之前」的部分交給模型寫成摘要,
// 摘要接在留下來的第一則使用者訊息最前面,後面的訊息原樣保留。outcome 把整理後的 transcript
// 交回前端(AgentChatOutcome.compacted),前端換掉自己那一份,畫面上的對話紀錄不動。
//
// 幾條紀律:
//   · 只在「使用者開口的那一則」前面切(不含 tool_result 的 user 訊息)。切在別處會留下
//     沒有 tool_use 的 tool_result,或反過來,上游會拒收。
//   · 摘要寫不出來(上游逾時、回空的)時:還沒到硬上限就先不整理,下次再試;到了硬上限
//     就直接丟掉較早的部分、放一句說明。對話不會因為整理失敗而送不出去。
//   · 純函式加一個注入的 chat:好測,也不讓本檔相依 loader。

import type { AiChatMessage, AiChatOptions, AiChatResult } from "./providers/ai";

/** 超過這個則數就整理。一輪最多 8 步(16 則),留給 /chat 的則數上限(80)很大的空間。 */
export const COMPACT_AT_MESSAGES = 40;
/** 或者文字總量超過這個字元數就整理(工具結果多的對話則數不多,字卻很多)。 */
export const COMPACT_AT_CHARS = 60_000;
/** 到這裡還沒整理成功,就不等摘要了,直接丟掉較早的部分。 */
export const COMPACT_HARD_MESSAGES = 60;
export const COMPACT_HARD_CHARS = 120_000;
/** 盡量留下最近這麼多則原文。 */
export const COMPACT_KEEP_MESSAGES = 10;
/** 交給模型寫摘要的原文最多這麼多字元(留尾巴:越近的越重要)。 */
export const COMPACT_SOURCE_MAX_CHARS = 40_000;
/** 原文裡單一段(一則文字、一筆工具結果)最多這麼多字元。 */
const BLOCK_MAX_CHARS = 1_500;
const SUMMARY_MAX_TOKENS = 2_000;
const SUMMARY_TIMEOUT_MS = 60_000;

/** 摘要那一段的開頭。模型靠它知道這是整理過的前情,不是使用者剛說的話。 */
export const SUMMARY_HEADING = "[Summary of the earlier part of this conversation]";
const DROPPED_NOTE =
  "The earlier part of this conversation was removed to keep it short, and its details are no longer available. Ask the administrator again for anything you need from it.";

const SUMMARY_SYSTEM =
  "You compress a conversation between a site administrator and an assistant that manages their website. " +
  "Write a summary the assistant can continue from. Keep: what the administrator asked for and prefers, " +
  "decisions made, what was actually changed (with ids, slugs, setting keys and values), what was looked up and found, " +
  "and anything still unfinished. Leave out pleasantries and failed attempts that no longer matter. " +
  "Write in the language the administrator writes in. Plain text, at most 400 words.";

function blockChars(block: AiChatMessage["content"][number]): number {
  if (block.type === "text") return block.text.length;
  if (block.type === "tool_result") return block.content.length;
  return JSON.stringify(block.input ?? null).length + block.name.length;
}

export function transcriptChars(messages: readonly AiChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.reduce((inner, block) => inner + blockChars(block), 0), 0);
}

const over = (messages: readonly AiChatMessage[], count: number, chars: number): boolean =>
  messages.length > count || transcriptChars(messages) > chars;

/** 使用者開口的那一則:user、沒有 tool_result。 */
function startsTurn(message: AiChatMessage): boolean {
  return message.role === "user" && message.content.length > 0 && message.content.every((block) => block.type !== "tool_result");
}

/**
 * 從哪一則開始留下原文。優先留最近 COMPACT_KEEP_MESSAGES 則以內;目前這一輪比那更長時,
 * 留整輪。找不到可以切的地方(整段只有一輪)回 null。
 */
export function pickCut(messages: readonly AiChatMessage[]): number | null {
  const turns = messages.map((message, index) => (index > 0 && startsTurn(message) ? index : -1)).filter((index) => index > 0);
  if (turns.length === 0) return null;
  const target = messages.length - COMPACT_KEEP_MESSAGES;
  return turns.find((index) => index >= target) ?? turns[turns.length - 1];
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 要整理的那一段 → 一份給模型讀的純文字。 */
export function renderForSummary(messages: readonly AiChatMessage[]): string {
  const lines = messages.flatMap((message) =>
    message.content.map((block) => {
      if (block.type === "text") return `${message.role === "user" ? "Administrator" : "Assistant"}: ${clip(block.text, BLOCK_MAX_CHARS)}`;
      if (block.type === "tool_use") return `Assistant called ${block.name} with ${clip(JSON.stringify(block.input ?? null), BLOCK_MAX_CHARS)}`;
      return `Result${block.isError ? " (error)" : ""}: ${clip(block.content, BLOCK_MAX_CHARS)}`;
    }),
  );
  const text = lines.join("\n");
  return text.length > COMPACT_SOURCE_MAX_CHARS ? `…\n${text.slice(text.length - COMPACT_SOURCE_MAX_CHARS)}` : text;
}

/** 摘要接在留下來的第一則(使用者開口的那一則)最前面:不多一則訊息,user/assistant 照樣交替。 */
function withSummary(kept: readonly AiChatMessage[], summary: string): AiChatMessage[] {
  const [first, ...rest] = kept;
  return [{ role: first.role, content: [{ type: "text", text: `${SUMMARY_HEADING}\n${summary}` }, ...first.content] }, ...rest];
}

export interface CompactResult {
  /** 接下來要用的 transcript(沒整理時就是原本那一份)。 */
  messages: AiChatMessage[];
  compacted: boolean;
  /** 為了寫摘要而打的那一次上游(有打才有;記用量用)。 */
  call?: AiChatResult;
}

export async function compactTranscript(
  messages: AiChatMessage[],
  chat: (opts: AiChatOptions) => Promise<AiChatResult>,
): Promise<CompactResult> {
  if (!over(messages, COMPACT_AT_MESSAGES, COMPACT_AT_CHARS)) return { messages, compacted: false };
  const cut = pickCut(messages);
  if (cut === null) return { messages, compacted: false };

  let call: AiChatResult;
  try {
    call = await chat({
      messages: [{ role: "user", content: [{ type: "text", text: `Summarise this conversation so far:\n\n${renderForSummary(messages.slice(0, cut))}` }] }],
      tools: [],
      system: SUMMARY_SYSTEM,
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
  } catch (e) {
    call = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "compact_failed" };
  }
  const summary = call.ok ? (call.text ?? "").trim() : "";
  if (summary) return { messages: withSummary(messages.slice(cut), summary), compacted: true, call };
  // 摘要沒寫成。還撐得住就原樣繼續(下一則訊息再試);撐不住就丟掉較早的部分。
  if (!over(messages, COMPACT_HARD_MESSAGES, COMPACT_HARD_CHARS)) return { messages, compacted: false, call };
  return { messages: withSummary(messages.slice(cut), DROPPED_NOTE), compacted: true, call };
}
