import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// settings.ts 的 stamp-based module memo binding-backed 整合測試(miniflare D1)。
// 同既有慣例:mock @/lib/cf 讓 db()/getDB() 直接打到 cloudflare:test 的 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock(同 notify.test.ts 慣例):getSetting → secretKeySetAsync 與
// setSettings → doAction 都會 dynamic import loader;真實 loader 會經 interpret →
// DetailView 拉進 next/navigation,在 workers pool 靜態解析會炸。空 rt.enabled 讓
// secret 判定只剩 CORE_SETTINGS,且 settings:saved dispatch 變 no-op。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import {
  getSetting,
  setSettings,
  invalidateSettingsCache,
} from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";

async function seedSetting(key: string, value: unknown, updatedAt: number): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), updatedAt)
    .run();
}

/** 只改 value、不動 updated_at:count 與 MAX(updated_at) 皆不變 → stamp 相同(模擬 memo 命中)。 */
async function rawUpdateSameStamp(key: string, value: unknown): Promise<void> {
  await d1()
    .prepare("UPDATE settings SET value = ? WHERE key = ?")
    .bind(JSON.stringify(value), key)
    .run();
}

beforeAll(async () => {
  await d1().exec(SETTINGS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache();
});

describe("settings stamp-based memo", () => {
  it("reuses the memoized map while the stamp is unchanged", async () => {
    await seedSetting("core.siteTitle", "A", 1000);
    expect(await getSetting("core.siteTitle")).toBe("A"); // 讀一次,填 memo

    // 改 value 但不動 updated_at → stamp 不變 → memo 命中 → 仍回舊值。
    await rawUpdateSameStamp("core.siteTitle", "B");
    expect(await getSetting("core.siteTitle")).toBe("A");
  });

  it("reflects a change immediately once the stamp moves (updated_at bump) — no manual invalidation", async () => {
    await seedSetting("core.siteTitle", "A", 1000);
    expect(await getSetting("core.siteTitle")).toBe("A"); // 填 memo

    // bump updated_at → stamp 變 → 下一次讀即時看到新值(非 TTL,不需手動失效)。
    await seedSetting("core.siteTitle", "B", 2000);
    expect(await getSetting("core.siteTitle")).toBe("B");
  });

  it("reflects a newly inserted key immediately (row count changes the stamp)", async () => {
    await seedSetting("core.siteTitle", "A", 1000);
    expect(await getSetting("core.siteTitle")).toBe("A"); // 填 memo
    expect(await getSetting("core.siteDescription", "")).toBe(""); // 尚無此 key

    await seedSetting("core.siteDescription", "hello", 1500); // 新 row → count 變
    expect(await getSetting("core.siteDescription", "")).toBe("hello");
  });

  it("reflects a deleted key immediately (row count changes the stamp)", async () => {
    await seedSetting("core.siteTitle", "A", 1000);
    expect(await getSetting("core.siteTitle", "fallback")).toBe("A"); // 填 memo

    await d1().exec("DELETE FROM settings WHERE key = 'core.siteTitle';");
    expect(await getSetting("core.siteTitle", "fallback")).toBe("fallback");
  });

  it("setSettings writes are immediately visible", async () => {
    await setSettings({ "core.siteTitle": "One" });
    expect(await getSetting("core.siteTitle")).toBe("One");

    await setSettings({ "core.siteTitle": "Two" });
    expect(await getSetting("core.siteTitle")).toBe("Two");
  });

  it("invalidateSettingsCache forces a fresh read even when the stamp is unchanged", async () => {
    await seedSetting("core.siteTitle", "A", 1000);
    expect(await getSetting("core.siteTitle")).toBe("A"); // 填 memo

    await rawUpdateSameStamp("core.siteTitle", "B"); // stamp 不變(memo 仍會命中)
    invalidateSettingsCache(); // 主動清 memo → 強制全表重讀
    expect(await getSetting("core.siteTitle")).toBe("B");
  });

  it("falls back to a full-table read when the memo cannot be trusted (no stamp match)", async () => {
    // 無 memo(beforeEach 已清)且表有資料 → 直接全表讀,回正確值。
    await seedSetting("core.locale", "zh-Hant", 1000);
    expect(await getSetting("core.locale", "en")).toBe("zh-Hant");
  });
});
