import { describe, it, expect, vi } from "vitest";

// custom-worker.ts 的 `scheduled` handler 實作(extensions/cron/scheduled.ts)單元測試。
//
// 重點不只是「有沒有送出請求」,而是**送出的簽章能不能被 CronTickProvider 驗過** ——
// 錶(這支)與鎖(provider)是兩份獨立的 HMAC 實作,只有讓真正的 verifyCallback 驗一次,
// 才能證明配方沒有漂移。runDueJobs 全 mock(provider 只用來驗簽,不真的跑任務)。

vi.mock("@/lib/jobs", () => ({ runDueJobs: vi.fn(async () => []) }));

import { runCronTick, type CronScheduledEnv } from "../extensions/cron/scheduled";
import { encryptSecretWithKey, decryptSecretWithKey } from "../src/lib/secret-envelope";
import { CronTickProvider } from "../extensions/cron/provider";
import type { CoreServices } from "../src/ext/services";

// vitest.config.ts 的 miniflare bindings 用的同一把 TEST-ONLY 金鑰。
const SECRETS_KEY = "GQ+clWLADtK1luUJYOxMfq6KBbzZL40jyjGQ3fYlwvY=";
const SECRET = "s3cr3t-cron-key";

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

interface TickRowShape {
  secret: string | null;
  site_url: string | null;
  enabled: number | null;
}

/** 假 D1:只支援 prepare().bind().first(),回傳固定的一列。 */
function fakeDB(row: TickRowShape | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => row }),
    }),
  } as unknown as D1Database;
}

/** 假 service binding:把送出的請求收下來,回 200。 */
function fakeFetcher(
  captured: CapturedRequest[],
  status = 200,
): Fetcher {
  return {
    fetch: async (input: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({
        url: input,
        method: init?.method,
        headers,
        body: String(init?.body ?? ""),
      });
      return new Response(null, { status });
    },
  } as unknown as Fetcher;
}

async function storedSecret(plaintext: string): Promise<string> {
  return JSON.stringify(await encryptSecretWithKey(SECRETS_KEY, plaintext));
}

async function envWith(
  row: TickRowShape | null,
  captured: CapturedRequest[],
  status = 200,
): Promise<CronScheduledEnv> {
  return {
    DB: fakeDB(row),
    SECRETS_KEY,
    WORKER_SELF_REFERENCE: fakeFetcher(captured, status),
  };
}

/** fake CoreServices:只實作 provider 驗簽會用到的 settings.get。 */
function verifierFor(secret: string): CronTickProvider {
  const services = {
    settings: {
      get: async <T,>(key: string, fallback?: T) =>
        (key === "ext.cron.secret" ? secret : fallback) as T,
    },
  } as unknown as CoreServices;
  return new CronTickProvider(services);
}

describe("secret-envelope", () => {
  it("加解密 round-trip 還原原文", async () => {
    const sealed = await encryptSecretWithKey(SECRETS_KEY, SECRET);
    expect(sealed).not.toContain(SECRET);
    expect(await decryptSecretWithKey(SECRETS_KEY, sealed)).toBe(SECRET);
  });

  it("每次加密都用新 IV(同明文兩次密文不同)", async () => {
    const a = await encryptSecretWithKey(SECRETS_KEY, SECRET);
    const b = await encryptSecretWithKey(SECRETS_KEY, SECRET);
    expect(a).not.toBe(b);
  });

  it("換金鑰 → 解不開(AES-GCM 認證失敗)", async () => {
    const sealed = await encryptSecretWithKey(SECRETS_KEY, SECRET);
    const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(decryptSecretWithKey(other, sealed)).rejects.toThrow();
  });

  it("缺 SECRETS_KEY → fail loud", async () => {
    await expect(encryptSecretWithKey("", SECRET)).rejects.toThrow(
      "SECRETS_KEY not configured",
    );
  });

  it("16-byte SECRETS_KEY → 拒絕非 AES-256 的設定", async () => {
    const aes128Key = btoa("0123456789abcdef");
    await expect(encryptSecretWithKey(aes128Key, SECRET)).rejects.toThrow(
      "SECRETS_KEY must be a base64-encoded 32-byte AES-256 key",
    );
  });
});

describe("runCronTick — 送出的 tick", () => {
  it("打 /api/callback/cron:tick/cron,簽章可被 CronTickProvider 驗過", async () => {
    const captured: CapturedRequest[] = [];
    const env = await envWith(
      {
        secret: await storedSecret(SECRET),
        site_url: JSON.stringify("https://cms.example.com"),
        enabled: 1,
      },
      captured,
    );

    await runCronTick(env);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toBe("https://cms.example.com/api/callback/cron:tick/cron");
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");

    // 這是本測試的核心:真正的驗簽端必須認得這個簽章。
    const ok = await verifierFor(SECRET).verifyCallback(
      req.body,
      new Headers(req.headers),
    );
    expect(ok).toBe(true);
  });

  it("body 是 {ts:<epoch ms>},且簽章綁定整段 raw body", async () => {
    const captured: CapturedRequest[] = [];
    const before = Date.now();
    await runCronTick(
      await envWith(
        {
          secret: await storedSecret(SECRET),
          site_url: null,
          enabled: 1,
        },
        captured,
      ),
    );
    const after = Date.now();

    const parsed = JSON.parse(captured[0].body) as { ts: number };
    expect(parsed.ts).toBeGreaterThanOrEqual(before);
    expect(parsed.ts).toBeLessThanOrEqual(after);

    // 動一個 byte 就驗不過。
    const tampered = await verifierFor(SECRET).verifyCallback(
      captured[0].body + " ",
      new Headers(captured[0].headers),
    );
    expect(tampered).toBe(false);
  });

  it("core.siteUrl 未設 / 非法 → 用佔位 origin(service binding 不看 host)", async () => {
    for (const siteUrl of [null, JSON.stringify("not a url"), JSON.stringify("")]) {
      const captured: CapturedRequest[] = [];
      await runCronTick(
        await envWith(
          { secret: await storedSecret(SECRET), site_url: siteUrl, enabled: 1 },
          captured,
        ),
      );
      expect(captured[0].url).toBe(
        "http://cron.local/api/callback/cron:tick/cron",
      );
    }
  });
});

describe("runCronTick — 安靜 no-op 的情形", () => {
  it("extension 未安裝(查無列)→ 不送", async () => {
    const captured: CapturedRequest[] = [];
    await runCronTick(await envWith(null, captured));
    expect(captured).toHaveLength(0);
  });

  it("extension 已安裝但未啟用 → 不送", async () => {
    const captured: CapturedRequest[] = [];
    await runCronTick(
      await envWith(
        { secret: await storedSecret(SECRET), site_url: null, enabled: 0 },
        captured,
      ),
    );
    expect(captured).toHaveLength(0);
  });

  it("已啟用但未設 signing secret → 不送(對應 provider 的 fail-closed)", async () => {
    const captured: CapturedRequest[] = [];
    await runCronTick(
      await envWith(
        { secret: JSON.stringify(""), site_url: null, enabled: 1 },
        captured,
      ),
    );
    expect(captured).toHaveLength(0);

    const captured2: CapturedRequest[] = [];
    await runCronTick(
      await envWith({ secret: null, site_url: null, enabled: 1 }, captured2),
    );
    expect(captured2).toHaveLength(0);
  });

  it("缺 binding(DB / SECRETS_KEY / WORKER_SELF_REFERENCE)→ 不 throw、不送", async () => {
    const captured: CapturedRequest[] = [];
    const full = await envWith(
      { secret: await storedSecret(SECRET), site_url: null, enabled: 1 },
      captured,
    );
    await expect(runCronTick({ ...full, DB: undefined })).resolves.toBeUndefined();
    await expect(
      runCronTick({ ...full, SECRETS_KEY: undefined }),
    ).resolves.toBeUndefined();
    await expect(
      runCronTick({ ...full, WORKER_SELF_REFERENCE: undefined }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("SECRETS_KEY 對不上(解不開密文)→ 不 throw、不送", async () => {
    const captured: CapturedRequest[] = [];
    const env = await envWith(
      { secret: await storedSecret(SECRET), site_url: null, enabled: 1 },
      captured,
    );
    const wrongKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    await expect(
      runCronTick({ ...env, SECRETS_KEY: wrongKey }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("D1 查詢失敗 → 不 throw", async () => {
    const env: CronScheduledEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error("d1 down");
            },
          }),
        }),
      } as unknown as D1Database,
      SECRETS_KEY,
      WORKER_SELF_REFERENCE: fakeFetcher([]),
    };
    await expect(runCronTick(env)).resolves.toBeUndefined();
  });

  it("callback 回非 2xx / fetch throw → 不 throw", async () => {
    const captured: CapturedRequest[] = [];
    const row = {
      secret: await storedSecret(SECRET),
      site_url: null,
      enabled: 1,
    };
    await expect(
      runCronTick(await envWith(row, captured, 403)),
    ).resolves.toBeUndefined();

    const throwing: CronScheduledEnv = {
      DB: fakeDB(row),
      SECRETS_KEY,
      WORKER_SELF_REFERENCE: {
        fetch: async () => {
          throw new Error("network");
        },
      } as unknown as Fetcher,
    };
    await expect(runCronTick(throwing)).resolves.toBeUndefined();
  });
});

// 「不 throw」原本也等於「沒有人知道」—— cron 從上週就沒跳過,而站台只是看起來
// 排程發佈有點慢。onError 是那個缺口的旁路出口:合約(絕不 throw)完全沒變,只是
// 失敗多了一個看得到的地方。這裡測的就是「該回報時回報、不該回報時安靜」。
describe("runCronTick — 失敗回報(onError sink)", () => {
  it("正常送出 → 一次都不回報", async () => {
    const captured: CapturedRequest[] = [];
    const reported: string[] = [];
    await runCronTick(
      await envWith(
        { secret: await storedSecret(SECRET), site_url: null, enabled: 1 },
        captured,
      ),
      (_e, stage) => reported.push(stage),
    );
    expect(captured).toHaveLength(1);
    expect(reported).toEqual([]);
  });

  it("未安裝 / 未啟用 / 未設密鑰 → 不回報(這些是正常狀態,不是故障)", async () => {
    const reported: string[] = [];
    const sink = (_e: unknown, stage: string) => reported.push(stage);
    await runCronTick(await envWith(null, []), sink);
    await runCronTick(
      await envWith(
        { secret: await storedSecret(SECRET), site_url: null, enabled: 0 },
        [],
      ),
      sink,
    );
    await runCronTick(
      await envWith({ secret: null, site_url: null, enabled: 1 }, []),
      sink,
    );
    expect(reported).toEqual([]);
  });

  it("D1 查詢失敗 → 回報 query,且照樣不 throw", async () => {
    const reported: string[] = [];
    const env: CronScheduledEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error("d1 down");
            },
          }),
        }),
      } as unknown as D1Database,
      SECRETS_KEY,
      WORKER_SELF_REFERENCE: fakeFetcher([]),
    };
    await expect(
      runCronTick(env, (_e, stage) => reported.push(stage)),
    ).resolves.toBeUndefined();
    expect(reported).toEqual(["query"]);
  });

  it("SECRETS_KEY 對不上 → 回報 decrypt", async () => {
    const reported: string[] = [];
    const env = await envWith(
      { secret: await storedSecret(SECRET), site_url: null, enabled: 1 },
      [],
    );
    const wrongKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    await runCronTick({ ...env, SECRETS_KEY: wrongKey }, (_e, stage) =>
      reported.push(stage),
    );
    expect(reported).toEqual(["decrypt"]);
  });

  it("入口回非 2xx → 回報 dispatch(沒有例外可轉發,所以自己組一個)", async () => {
    const reported: unknown[] = [];
    await runCronTick(
      await envWith(
        { secret: await storedSecret(SECRET), site_url: null, enabled: 1 },
        [],
        403,
      ),
      (e, stage) => reported.push([stage, (e as Error).message]),
    );
    expect(reported).toEqual([["dispatch", "cron tick rejected with HTTP 403"]]);
  });

  it("fetch 自己 throw → 回報 dispatch", async () => {
    const reported: string[] = [];
    const throwing: CronScheduledEnv = {
      DB: fakeDB({
        secret: await storedSecret(SECRET),
        site_url: null,
        enabled: 1,
      }),
      SECRETS_KEY,
      WORKER_SELF_REFERENCE: {
        fetch: async () => {
          throw new Error("network");
        },
      } as unknown as Fetcher,
    };
    await expect(
      runCronTick(throwing, (_e, stage) => reported.push(stage)),
    ).resolves.toBeUndefined();
    expect(reported).toEqual(["dispatch"]);
  });
});
