import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";

// @/lib/request-stamps:settings 與 extension runtime 的版本戳合成一趟 D1。
// 真 D1(miniflare)驗證合併查詢與兩條獨立查詢產生**一模一樣**的字串 —— memo 以字串
// 比對新鮮度,兩條路格式一旦分歧,每次走不同路徑都會被當成「有變動」而重讀。
// 假 DB 驗證其中一張表不存在時,另一組戳照樣算得出來。

const dbState = vi.hoisted(() => ({ override: null as unknown }));
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => dbState.override ?? (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

import { computeSettingsStamp, getRequestStamps } from "../src/lib/request-stamps";
import { computeExtRuntimeStamp } from "../src/ext/runtime-stamp";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  // 與 migrations/0000(settings、extensions)、0001(declarative_extensions)同形。
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
  dbState.override = null;
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM extensions;");
  await d1().exec("DELETE FROM declarative_extensions;");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRequestStamps", () => {
  it("matches the separate queries exactly on empty tables", async () => {
    const stamps = await getRequestStamps();
    expect(stamps).toEqual({
      settings: { ok: true, stamp: await computeSettingsStamp() },
      extensions: { ok: true, stamp: await computeExtRuntimeStamp() },
    });
    expect(stamps).toEqual({
      settings: { ok: true, stamp: "0:0" },
      extensions: { ok: true, stamp: "0:0:0|0:0:0" },
    });
  });

  it("matches the separate queries exactly with rows in every table", async () => {
    await d1().batch([
      d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.siteTitle', '\"A\"', 1700000000123)"),
      d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('core.locale', '\"en\"', 1700000000456)"),
      d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('shop', 1, '1.0.0', 1, 1700000000789)"),
      d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('cron', 0, '1.0.0', 1, 1700000000001)"),
      d1().prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES ('gallery', '{}', '1.0.0', 1, NULL, 1, 1700000000999)"),
    ]);
    const stamps = await getRequestStamps();
    expect(stamps).toEqual({
      settings: { ok: true, stamp: await computeSettingsStamp() },
      extensions: { ok: true, stamp: await computeExtRuntimeStamp() },
    });
    expect(stamps.settings).toEqual({ ok: true, stamp: "2:1700000000456" });
    expect(stamps.extensions).toEqual({ ok: true, stamp: "2:1700000000789:1|1:1700000000999:1" });
  });

  it("still stamps settings when the extension tables are missing, and logs nothing itself", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // 假 DB:凡是碰到 extensions 表的查詢都失敗(模擬只建了 settings 表的庫)。
    dbState.override = {
      prepare: (sql: string) => ({
        first: async () => {
          if (/\bextensions\b/.test(sql)) throw new Error("D1_ERROR: no such table: extensions");
          return { n: 3, m: 42 };
        },
      }),
    };
    const stamps = await getRequestStamps();
    expect(stamps.settings).toEqual({ ok: true, stamp: "3:42" });
    expect(stamps.extensions.ok).toBe(false);
    // 記錯是用到那一組戳的呼叫端的事:只讀 settings 的 request 不該冒出 loader 的錯誤。
    expect(error).not.toHaveBeenCalled();
  });

  it("reports both as failed when D1 is unreachable, without throwing", async () => {
    dbState.override = {
      prepare: () => ({
        first: async () => {
          throw new Error("network");
        },
      }),
    };
    const stamps = await getRequestStamps();
    expect(stamps.settings.ok).toBe(false);
    expect(stamps.extensions.ok).toBe(false);
  });
});
