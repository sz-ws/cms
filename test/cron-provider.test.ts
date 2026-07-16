import { describe, it, expect, beforeEach, vi } from "vitest";

// CronTickProvider 單元測試:HMAC-SHA256 驗簽(fail-closed / 錯簽 / 正確簽)+
// handleCallback 催動 runDueJobs 並寫 lastTick marker。runDueJobs 全 mock —— 不碰
// D1/loader(避開 workers pool 地雷),只驗 provider 自身的驗簽與副作用契約。

const jobsState = vi.hoisted(() => ({
  reports: [] as unknown[],
  calls: [] as number[],
}));
vi.mock("@/lib/jobs", () => ({
  runDueJobs: vi.fn(async (now: number) => {
    jobsState.calls.push(now);
    return jobsState.reports;
  }),
}));

import { CronTickProvider } from "../extensions/cron/provider";
import type { CoreServices } from "../src/ext/services";

const SECRET_KEY = "ext.cron.secret";
const LAST_TICK_KEY = "ext.cron.lastTick";

/** 以 secret 對 body 做 HMAC-SHA256 → hex（與 provider 的驗簽對稱）。 */
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** fake CoreServices：只實作 provider 會用到的 settings.get/set。 */
function fakeServices(initial: Record<string, unknown> = {}): {
  services: CoreServices;
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = { ...initial };
  const services = {
    settings: {
      get: async <T,>(key: string, fallback?: T) =>
        (key in store ? store[key] : fallback) as T,
      set: async (entries: Record<string, unknown>) => {
        Object.assign(store, entries);
      },
    },
  } as unknown as CoreServices;
  return { services, store };
}

function headers(sig?: string): Headers {
  const h = new Headers({ "content-type": "application/json" });
  if (sig !== undefined) h.set("x-signature", sig);
  return h;
}

const SECRET = "s3cr3t-cron-key";
const BODY = JSON.stringify({ ts: 1_700_000_000_000 });

describe("CronTickProvider.verifyCallback", () => {
  it("未設 secret → false（fail closed），即使簽章格式正確", async () => {
    const { services } = fakeServices({}); // 無 ext.cron.secret
    const provider = new CronTickProvider(services);
    const sig = await hmacHex(SECRET, BODY);
    expect(await provider.verifyCallback(BODY, headers(sig))).toBe(false);
  });

  it("缺 x-signature header → false", async () => {
    const { services } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);
    expect(await provider.verifyCallback(BODY, headers())).toBe(false);
  });

  it("錯誤簽章 → false", async () => {
    const { services } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);
    const wrong = await hmacHex("wrong-secret", BODY);
    expect(await provider.verifyCallback(BODY, headers(wrong))).toBe(false);
  });

  it("非 hex / 奇數長度簽章 → false", async () => {
    const { services } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);
    expect(await provider.verifyCallback(BODY, headers("zzz"))).toBe(false);
    expect(await provider.verifyCallback(BODY, headers("abc"))).toBe(false);
  });

  it("正確簽章 → true", async () => {
    const { services } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);
    const sig = await hmacHex(SECRET, BODY);
    expect(await provider.verifyCallback(BODY, headers(sig))).toBe(true);
  });

  it("簽章對整段 raw body 綁定：body 被改則驗不過", async () => {
    const { services } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);
    const sig = await hmacHex(SECRET, BODY);
    expect(await provider.verifyCallback(BODY + " ", headers(sig))).toBe(false);
  });
});

describe("CronTickProvider.handleCallback", () => {
  beforeEach(() => {
    jobsState.reports = [];
    jobsState.calls = [];
  });

  it("催動 runDueJobs 並寫 ext.cron.lastTick（epoch ms）", async () => {
    jobsState.reports = [{ id: "publish-due", ok: true, processed: 2 }];
    const { services, store } = fakeServices({ [SECRET_KEY]: SECRET });
    const provider = new CronTickProvider(services);

    const before = Date.now();
    // handle 不解析 rawBody（簽章已對整段驗過），故零參數即為完整契約。
    await provider.handleCallback();
    const after = Date.now();

    // runDueJobs 被呼叫一次。
    expect(jobsState.calls).toHaveLength(1);
    // lastTick marker 寫入且為合理的 epoch ms。
    const tick = store[LAST_TICK_KEY];
    expect(typeof tick).toBe("number");
    expect(tick as number).toBeGreaterThanOrEqual(before);
    expect(tick as number).toBeLessThanOrEqual(after);
  });
});
