import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 錯誤回報的 SDK 只在「真的有東西要送」時才載入(冷啟動:@sentry/nextjs 是 server
// bundle 裡最大的一塊)。這裡守兩件事:
//   1. 沒設 DSN → 整支 SDK 連 import 都不發生(mock 的 factory 一次都沒被叫到);
//   2. 有設 → 回報照舊送得出去(init / capture / flush 都有走到)。
// 涵蓋 src/instrumentation.ts 的 onRequestError(經 src/lib/observe/bridge.ts 轉給
// report.ts)與 cron 那條路的 extensions/sentry/scheduled.ts。

const sdk = vi.hoisted(() => ({
  loads: 0,
  client: null as null | { getOptions: () => { dsn?: string } },
  init: [] as unknown[],
  captured: [] as unknown[],
  requestErrors: [] as unknown[][],
  flushed: 0,
}));

// 用 doMock 在每個測試前重新登記(見 beforeEach):hoisted 的 vi.mock 的 factory 結果
// 會跨 vi.resetModules 留著,那樣「第二個測試起 SDK 有沒有被載入」就量不到了。
const sentryFactory = () => {
  sdk.loads++;
  return {
    init: (options: { dsn?: string }) => {
      sdk.init.push(options);
      sdk.client = { getOptions: () => ({ dsn: options.dsn }) };
    },
    getClient: () => sdk.client,
    captureException: (error: unknown) => {
      sdk.captured.push(error);
      return "event-id";
    },
    captureRequestError: (...args: unknown[]) => {
      sdk.requestErrors.push(args);
    },
    flush: async () => {
      sdk.flushed++;
      return true;
    },
  };
};

// report.ts 的 resolveReporting 會讀 core.siteUrl 與 extension runtime(D1)。這裡讓它
// 讀不到任何設定、sentry extension 沒裝 —— DSN 與 origin 全由環境變數決定。
vi.mock("@/lib/settings", () => ({
  getSetting: async (_key: string, fallback?: unknown) => fallback,
}));
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({ byId: () => undefined }),
}));

const DSN = "https://publickey@glitchtip.example.com/7";
const ORIGIN = "https://cms.example.com";
const ENV_KEYS = ["CMS_ERROR_DSN", "CMS_ERROR_ORIGIN"] as const;
const BRIDGE_KEY = Symbol.for("cms.observe.onRequestError");
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules(); // report.ts / scheduled.ts 都有 isolate 級狀態,每個測試要新的一份。
  vi.doMock("@sentry/nextjs", sentryFactory);
  Object.assign(sdk, {
    loads: 0,
    client: null,
    init: [],
    captured: [],
    requestErrors: [],
    flushed: 0,
  });
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
});

describe("src/instrumentation.ts — onRequestError", () => {
  const request = { path: "/x", method: "GET", headers: {} };
  const context = {
    routerKind: "App Router",
    routePath: "/x",
    routeType: "render",
    renderSource: "react-server-components",
    revalidateReason: undefined,
  } as const;

  it("report.ts 還沒載入(橋沒掛):安靜略過,不 throw、不載 SDK", async () => {
    const { onRequestError } = await import("../src/instrumentation");
    await expect(onRequestError(new Error("boom"), request, context)).resolves.toBeUndefined();
    expect(sdk.loads).toBe(0);
  });

  it("report.ts 載入時自己掛上橋", async () => {
    const report = await import("../src/lib/observe/report");
    const { getRequestErrorForwarder } = await import("../src/lib/observe/bridge");
    expect(getRequestErrorForwarder()).toBe(report.captureRequestError);
  });

  it("沒設 DSN:錯誤經橋轉到 report.ts,但 SDK 不載入", async () => {
    await import("../src/lib/observe/report");
    const { onRequestError } = await import("../src/instrumentation");
    await onRequestError(new Error("boom"), request, context);
    expect(sdk.loads).toBe(0);
    expect(sdk.requestErrors).toHaveLength(0);
  });

  it("有 DSN:載入 SDK、綁上 DSN,captureRequestError 收到原樣參數", async () => {
    process.env.CMS_ERROR_DSN = DSN;
    process.env.CMS_ERROR_ORIGIN = ORIGIN;
    await import("../src/lib/observe/report");
    const { onRequestError } = await import("../src/instrumentation");
    const error = new Error("boom");
    await onRequestError(error, request, context);
    expect(sdk.loads).toBe(1);
    expect(sdk.init).toHaveLength(1);
    expect(sdk.requestErrors).toEqual([[error, request, context]]);
  });
});

describe("extensions/sentry/scheduled.ts — withScheduledReporting", () => {
  it("沒設 DSN:工作照跑,SDK 不載入,report 是安靜的 no-op", async () => {
    const { withScheduledReporting } = await import("../extensions/sentry/scheduled");
    let ran = false;
    await withScheduledReporting({}, async (report) => {
      ran = true;
      report(new Error("tick failed"), "dispatch");
    });
    expect(ran).toBe(true);
    expect(sdk.loads).toBe(0);
    expect(sdk.captured).toHaveLength(0);
    expect(sdk.flushed).toBe(0);
  });

  it("有 DSN:載入 SDK、init 一次、回報並 flush;run 丟出的例外也被接住回報", async () => {
    const { withScheduledReporting } = await import("../extensions/sentry/scheduled");
    const env = { CMS_ERROR_DSN: DSN, CMS_ERROR_ORIGIN: ORIGIN };
    const reported = new Error("tick failed");
    const thrown = new Error("unhandled");

    await withScheduledReporting(env, async (report) => {
      report(reported, "dispatch");
      throw thrown;
    });

    expect(sdk.loads).toBe(1);
    expect(sdk.init).toHaveLength(1);
    expect(sdk.captured).toEqual([reported, thrown]);
    expect(sdk.flushed).toBe(1);

    // 同一個 isolate 的下一次 tick:沿用已綁的 client,不重新 init。
    await withScheduledReporting(env, async () => {});
    expect(sdk.init).toHaveLength(1);
  });
});
