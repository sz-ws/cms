// ai:generate capability 的共用內部工具(docs/spec-ai-capability.md)。
//
// 為什麼獨立成一檔:generate/generateStream(./ai.ts)與 tool-calling 的 chat
// (./ai-chat.ts)共用同一組「共同慣例」—— 60s 逾時預算、錯誤摘要截 200 字、
// maxTokens 的 default/cap、三種 mode 的預設 baseUrl。這些是 spec 明定的規則,
// 只能有一份;複製一份到 chat 那邊遲早會漂移。抽出來也讓 ai.ts 在長出第三個
// 方法之後仍守得住檔案大小上限。純搬移,行為零變更。
//
// 這裡只放與 provider 無關的共用件;wire format(SSE 解析、各家 body 形狀)
// 各自留在 ai.ts / ai-chat.ts。

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
