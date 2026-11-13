// The one retry policy for remote calls: transient failures (rate limits, 5xx,
// dropped connections, Cloudflare's intermittent 7403) are retried with a short
// backoff; everything else fails at once.

import { CloudflareError } from "./port.js";

export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTransient(e: unknown): boolean {
  return e instanceof CloudflareError && e.failure === "TRANSIENT";
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: Sleep = realSleep,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}
