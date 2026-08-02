import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";

import {
  layerOf,
  resolveDsn,
  scrubEvent,
  sentryOptions,
} from "../src/lib/observe/sentry-options";

// 錯誤回報的三個純函式:環境層級判定、刪去法清理、本機抑制。
//
// 為什麼這三個特別值得測:它們的失敗模式全部是**靜默**的。判錯層級 → 事件送出去但
// 標錯標籤;清理漏了 → 使用者資料離開機器;抑制邏輯反了 → 本機的錯誤混進正式站。
// 三種都不會有任何錯誤訊息,而且都要等到「已經發生了」才看得出來。

const DSN = "https://publickey@glitchtip.example.com/7";

describe("layerOf", () => {
  it("treats an absent or unparsable origin as local", () => {
    // 判不出來的時候寧可不送 —— local 就是靜音的那一層。
    expect(layerOf(undefined)).toBe("local");
    expect(layerOf(null)).toBe("local");
    expect(layerOf("")).toBe("local");
    expect(layerOf("not a url")).toBe("local");
  });

  it("treats loopback and dev hostnames as local", () => {
    expect(layerOf("http://localhost:3000")).toBe("local");
    expect(layerOf("http://127.0.0.1:8787")).toBe("local");
    expect(layerOf("https://cms.local")).toBe("local");
    expect(layerOf("https://cms.localhost")).toBe("local");
  });

  it("treats plain http on a public host as local too", () => {
    // 正式站在 Cloudflare 後面一定是 https。http 只可能是本機或某種轉發設定,
    // 兩者都不是「使用者看得到的那個站」。
    expect(layerOf("http://example.com")).toBe("local");
  });

  it("treats Cloudflare's default domains as staging", () => {
    expect(layerOf("https://cms.someone.workers.dev")).toBe("staging");
    expect(layerOf("https://cms.pages.dev")).toBe("staging");
  });

  it("treats a custom https domain as production", () => {
    expect(layerOf("https://cms.example.com")).toBe("production");
  });
});

describe("resolveDsn", () => {
  it("stays silent on local even when a DSN is configured", () => {
    expect(resolveDsn({ dsn: DSN, origin: "http://localhost:3000" })).toBeUndefined();
  });

  it("honours the explicit local escape hatch", () => {
    expect(
      resolveDsn({ dsn: DSN, origin: "http://localhost:3000", allowLocal: true }),
    ).toBe(DSN);
  });

  it("treats an empty or blank DSN as not configured", () => {
    // wrangler 的 var 與 Next 的建置期取代都會給出空字串而不是 undefined,而空字串
    // 會被 SDK 當成一顆壞掉的 DSN 而印警告。要的是安靜關閉,不是每次冷啟動抱怨。
    expect(resolveDsn({ dsn: "", origin: "https://cms.example.com" })).toBeUndefined();
    expect(resolveDsn({ dsn: "   ", origin: "https://cms.example.com" })).toBeUndefined();
    expect(resolveDsn({ dsn: undefined, origin: "https://cms.example.com" })).toBeUndefined();
  });

  it("sends on deployed layers", () => {
    expect(resolveDsn({ dsn: DSN, origin: "https://cms.example.com" })).toBe(DSN);
    expect(resolveDsn({ dsn: DSN, origin: "https://cms.x.workers.dev" })).toBe(DSN);
  });
});

describe("scrubEvent", () => {
  function eventWithRequest(): ErrorEvent {
    return {
      user: { id: "u1", email: "someone@example.com" },
      request: {
        url: "https://cms.example.com/admin/content?q=secret+search",
        method: "POST",
        headers: {
          Cookie: "session=abc",
          "X-Api-Token": "t0ken",
          "x-signature": "deadbeef",
          Authorization: "Bearer nope",
          "User-Agent": "Mozilla/5.0",
        },
        cookies: { session: "abc" },
        query_string: "q=secret+search",
        data: { password: "hunter2" },
      },
    } as unknown as ErrorEvent;
  }

  it("drops credentials, bodies and query strings", () => {
    const scrubbed = scrubEvent(eventWithRequest());
    const headers = scrubbed.request?.headers ?? {};

    expect(scrubbed.user).toBeUndefined();
    expect(headers).not.toHaveProperty("Cookie");
    expect(headers).not.toHaveProperty("X-Api-Token");
    expect(headers).not.toHaveProperty("x-signature");
    expect(headers).not.toHaveProperty("Authorization");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    // 網址本身留著(要它才知道哪個路由壞了),但參數整段砍掉。
    expect(scrubbed.request?.url).toBe("https://cms.example.com/admin/content");
  });

  it("keeps the headers that actually help debugging", () => {
    const headers = scrubEvent(eventWithRequest()).request?.headers ?? {};
    expect(headers["User-Agent"]).toBe("Mozilla/5.0");
  });

  it("survives an event with no request at all", () => {
    // captureException 從 cron / hook 呼叫時就是這個形狀 —— 沒有 request 物件。
    const event = { message: "boom" } as unknown as ErrorEvent;
    expect(() => scrubEvent(event)).not.toThrow();
  });
});

describe("sentryOptions", () => {
  it("keeps everything GlitchTip cannot use switched off", () => {
    const options = sentryOptions({ dsn: DSN, origin: "https://cms.example.com" });
    expect(options.tracesSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.sampleRate).toBe(1);
    expect(options.environment).toBe("production");
  });

  it("produces a no-op configuration when nothing is set", () => {
    // 這是 fork 出去的新站的預設狀態:沒有 DSN → SDK 是 no-op,零網路流量。
    // 這個 repo 是公開範本,寫死任何 DSN 都會讓所有 fork 的錯誤送到原作者那裡。
    expect(sentryOptions({ dsn: undefined, origin: undefined }).dsn).toBeUndefined();
  });

  it("runs the scrubber through beforeSend", () => {
    const options = sentryOptions({ dsn: DSN, origin: "https://cms.example.com" });
    const event = {
      request: { url: "https://cms.example.com/x?token=1", data: { a: 1 } },
    } as unknown as ErrorEvent;
    const sent = options.beforeSend?.(event, {}) as ErrorEvent | null;
    expect(sent?.request?.data).toBeUndefined();
    expect(sent?.request?.url).toBe("https://cms.example.com/x");
  });
});
