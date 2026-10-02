import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 一個請求範圍(@/lib/request-scope)裡,版本戳只去 D1 問一次 —— Route Handler 沒有
// React cache() 的請求範圍,以前每讀一次設定就問一次。這個請求自己寫了設定之後要重問。

const counted = vi.hoisted(() => ({ stampQueries: 0, failStamps: 0 }));
vi.mock("@/lib/cf", () => {
  const real = () => (env as { DB: D1Database }).DB;
  const isStamp = (sql: string) => /COUNT\(\*\)/.test(sql) && /\bsettings\b/.test(sql);
  // 只數「戳」的查詢:prepare 的 SQL 帶 COUNT(*) 且讀 settings 的那一條。
  // failStamps > 0 時,接下來這麼多次戳的查詢都失敗(模擬 D1 一時連不上)。
  const counting = {
    prepare: (sql: string) => {
      if (isStamp(sql)) {
        counted.stampQueries += 1;
        if (counted.failStamps > 0) {
          counted.failStamps -= 1;
          return { first: async () => { throw new Error("D1_ERROR: network"); } };
        }
      }
      return real().prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => real().batch(statements),
    exec: (sql: string) => real().exec(sql),
  };
  return {
    getEnv: () => env,
    getDB: () => counting,
    getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
  };
});

// @/ext/loader 全 mock(同 settings-cache.test.ts):真的 loader 會拉進 next/navigation,
// 在 workers pool 載不起來。getSetting 與 setSettings 只需要一個空的 runtime。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = { enabled: [] as unknown[], all: [] as unknown[], hooks: new HookBus(), byId: () => undefined, isCompatible: () => true };
  return { getExtRuntime: async () => rt };
});

import { getRequestStamps, publishRequestStamps } from "../src/lib/request-stamps";
import { requestScope, runInRequestScope } from "../src/lib/request-scope";
import { getSetting, invalidateSettingsCache, setSettings } from "../src/lib/settings";

const d1 = () => (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache();
  counted.failStamps = 0;
  // 第一次算戳會走冷啟動的合併讀取(另一條 SQL);先暖一次,後面數的才是平常那一條。
  await getRequestStamps();
  counted.stampQueries = 0;
});

const writeSetting = (key: string, at: number) =>
  d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)").bind(key, at).run();

describe("request scope", () => {
  it("is absent outside a scope and shared inside one", () => {
    expect(requestScope()).toBeUndefined();
    runInRequestScope(() => {
      const outer = requestScope();
      expect(outer).toBeInstanceOf(Map);
      runInRequestScope(() => expect(requestScope()).toBe(outer));
    });
    expect(requestScope()).toBeUndefined();
  });

  it("gives each scope its own store", () => {
    const first = runInRequestScope(() => requestScope());
    const second = runInRequestScope(() => requestScope());
    expect(first).not.toBe(second);
  });

  it("keeps two requests apart while both are in flight", async () => {
    // 同一個 isolate 同時處理兩個請求:各自 await 之後拿到的還是自己的那一份。
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    const request = (name: string) =>
      runInRequestScope(async () => {
        requestScope()?.set("who", name);
        await tick();
        await tick();
        return requestScope()?.get("who");
      });
    expect(await Promise.all([request("a"), request("b")])).toEqual(["a", "b"]);
  });
});

describe("getRequestStamps in a request scope", () => {
  it("asks D1 every time when there is no scope (unchanged behaviour)", async () => {
    await getRequestStamps();
    await getRequestStamps();
    await getRequestStamps();
    expect(counted.stampQueries).toBe(3);
  });

  it("asks D1 once per scope, however many times it is read", async () => {
    await runInRequestScope(async () => {
      const first = await getRequestStamps();
      const again = await Promise.all([getRequestStamps(), getRequestStamps(), getRequestStamps()]);
      for (const stamps of again) expect(stamps).toEqual(first);
    });
    expect(counted.stampQueries).toBe(1);
  });

  it("asks again in the next scope, so a write shows up in the next request", async () => {
    const before = await runInRequestScope(() => getRequestStamps());
    await writeSetting("core.siteTitle", 1700000000123);
    const after = await runInRequestScope(() => getRequestStamps());
    expect(before.settings).toEqual({ ok: true, stamp: "0:0" });
    expect(after.settings).toEqual({ ok: true, stamp: "1:1700000000123" });
    expect(counted.stampQueries).toBe(2);
  });

  it("asks again in the same scope after this request wrote something", async () => {
    await runInRequestScope(async () => {
      expect((await getRequestStamps()).settings).toEqual({ ok: true, stamp: "0:0" });
      await writeSetting("core.locale", 1700000000456);
      // 每條寫入路徑寫完都會呼叫它(invalidateSettingsCache / invalidateExtRuntimeMemo)。
      publishRequestStamps();
      expect((await getRequestStamps()).settings).toEqual({ ok: true, stamp: "1:1700000000456" });
      await getRequestStamps();
    });
    expect(counted.stampQueries).toBe(2);
  });

  it("does not remember a failed answer: the next read asks again", async () => {
    await runInRequestScope(async () => {
      // 合併查詢失敗 → 退回兩條各自的查詢;settings 那一條也失敗(共兩次戳的查詢)。
      counted.failStamps = 2;
      expect((await getRequestStamps()).settings.ok).toBe(false);
      expect(counted.stampQueries).toBe(2);
      // D1 恢復了:同一個請求裡下一次讀就拿得到,而且之後記住。
      expect((await getRequestStamps()).settings).toEqual({ ok: true, stamp: "0:0" });
      await getRequestStamps();
      expect(counted.stampQueries).toBe(3);
    });
  });
});

describe("settings in a request scope", () => {
  it("reads many settings with one stamp query", async () => {
    await writeSetting("core.siteTitle", 1700000000123);
    await runInRequestScope(async () => {
      for (const key of ["core.siteTitle", "core.locale", "core.siteDescription", "core.siteUrl"]) await getSetting(key, null);
    });
    expect(counted.stampQueries).toBe(1);
  });

  it("sees its own write: setSettings then getSetting in the same request", async () => {
    await runInRequestScope(async () => {
      expect(await getSetting("core.siteTitle", "none")).toBe("none");
      await setSettings({ "core.siteTitle": "One" });
      expect(await getSetting("core.siteTitle", "none")).toBe("One");
      await setSettings({ "core.siteTitle": "Two" });
      expect(await getSetting("core.siteTitle", "none")).toBe("Two");
    });
  });

  it("sees a write that only invalidated: a raw insert followed by invalidateSettingsCache", async () => {
    // 外掛的 migration 之類:直接下 SQL,寫完由呼叫端失效。
    await runInRequestScope(async () => {
      expect(await getSetting("core.locale", "none")).toBe("none");
      await d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.locale', '\"zh-Hant\"', 1700000000789)").run();
      invalidateSettingsCache();
      expect(await getSetting("core.locale", "none")).toBe("zh-Hant");
    });
  });
});
