// ai:generate capability 的共用內部工具(docs/spec-ai-capability.md)。
//
// 為什麼獨立成一檔:generate/generateStream(./ai.ts)與 tool-calling 的 chat
// (./ai-chat.ts)共用同一組「共同慣例」—— 60s 逾時預算、錯誤摘要截 200 字、
// maxTokens 的 default/cap、三種 mode 的預設 baseUrl。這些是 spec 明定的規則,
// 只能有一份;複製一份到 chat 那邊遲早會漂移。抽出來也讓 ai.ts 在長出第三個
// 方法之後仍守得住檔案大小上限。純搬移,行為零變更。
//
// 這裡只放與 provider 無關的共用件。**SSE 的「框」**(把位元組流切成 event/data)
// 也算在內:它是 SSE 規範,不是任何一家的 wire format —— 1.32.0 起有四個消費者
// (generate 的三種 mode + chat 的兩種 mode),再複製一份就是四份會漂移的 buffer
// 邊界處理。各家 frame **裡面**的 body 形狀仍各自留在 ai.ts / ai-chat-stream.ts。

/** core.ai.mode 的四個合法值;其餘值一律當作未設定(見 ai.ts 的 dispatch)。 */
export type AiMode = "off" | "openai" | "anthropic" | "workers-ai";

export const GENERATE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_TOKENS_CAP = 8192;
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
const ERROR_DETAIL_MAX = 200; // 上游錯誤摘要截斷長度。

export function resolveMaxTokens(input: number | undefined): number {
  return Math.min(input ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP);
}

/** 截斷至 200 字(spec:上游訊息摘要),絕不含呼叫端傳入的 apiKey(呼叫處保證不拼入)。 */
export function truncate(s: string): string {
  return s.length > ERROR_DETAIL_MAX ? `${s.slice(0, ERROR_DETAIL_MAX)}…` : s;
}

/** env.AI.run() 無法傳 AbortSignal(binding 型別由呼叫端自訂,見 cf.ts),用通用
 * race 做逾時,語意與 fetch 版 AbortController 一致:逾時 reject Error("timeout")。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** withTimeout 的「絕對時間點」版本 —— workers-ai streaming 用(ai.run() 不是
 * fetch,沒有 AbortSignal 可傳,逐 chunk 讀取要對同一個 deadline 累計扣時,而非
 * 每次都重新給滿額 60s)。逾時語意與 withTimeout 一致:reject Error("timeout")。 */
export function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("timeout"));
  return withTimeout(promise, remaining);
}

export function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

export interface SseFrame {
  /** anthropic 用具名事件(`event: content_block_delta` 等);openai/workers-ai
   * 的 frame 只有 data 行,event 為 undefined。 */
  event?: string;
  data: string;
}

/** 把單一 SSE frame(`\n\n` 分隔的一段)解析成 { event?, data }。多個 data 行
 * 依 SSE 規範以 "\n" 接回;無 data 行(純 comment/其他欄位)回 null。 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
    // 其餘欄位(id: / retry: / 純 comment ":")與本檔的 provider 皆無關,略過。
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** 共用 SSE 串流解析器:generate 的三種 mode(ai.ts)與 chat 的兩種 mode
 * (ai-chat-stream.ts)皆由此驅動。frame 之間可能跨多次 TextDecoder read 才湊齊,
 * 因此用 buffer 累積、以 "\n\n" 切 frame,絕不假設一次 read 剛好對齊 frame 邊界。
 *
 * deadlineAt 提供時(只有 workers-ai 傳):每次 reader.read() 都對同一個絕對時間點
 * 扣時,逾時 reject Error("timeout")。openai/anthropic 不傳 —— 這兩者的逾時已由
 * fetch 的 AbortController 覆蓋(abort 會讓進行中的 reader.read() reject
 * AbortError),無需在此重複計時。 */
export async function* parseSseStream(
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
