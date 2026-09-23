import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.45.0:啟用／套用更新的逐步進度(manager.enableExtension 的 onStep、
// pendingCodeUpgrades)與後台進度卡的純函式(EnableProgress.tsx)。

const demo = vi.hoisted(() => ({
  id: "demo",
  name: "Demo",
  version: "1.1.0",
  coreApi: "^1.0.0",
  migrations: [
    { id: "0001_a", sql: "CREATE TABLE IF NOT EXISTS demo_a (id TEXT)" },
    { id: "0002_b", sql: "CREATE TABLE IF NOT EXISTS demo_b (id TEXT)" },
  ],
  settings: [
    { key: "mode", label: "Mode", type: "text", default: "a" },
    { key: "limit", label: "Limit", type: "number", default: 3 },
  ],
}));

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("@/../extensions/registry", () => ({ registry: [demo] }));
vi.mock("@/ext/loader", () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({ hooks: { doAction: async () => undefined } }),
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));

import { enableExtension, enableStepCheck, enableStepMigrate, pendingCodeUpgrades, type EnableStepEvent } from "../src/ext/manager";
import { applyStepEvent, initialSteps, markFailed, receiptSteps, withMigrations } from "../src/app/(admin)/admin/extensions/EnableProgress";

const d1 = () => (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions; DELETE FROM ext_migrations; DELETE FROM settings;");
});

async function enableAndCollect(): Promise<EnableStepEvent[]> {
  const events: EnableStepEvent[] = [];
  await enableExtension("demo", (e) => events.push(e));
  return events;
}

describe("enableExtension progress", () => {
  it("第一次啟用:每一步依序回報,每個 migration 各一組", async () => {
    expect(await enableAndCollect()).toEqual([
      { step: "check", status: "running" },
      { step: "check", status: "done" },
      { step: "migrate", status: "running", migration: "0001_a" },
      { step: "migrate", status: "done", migration: "0001_a" },
      { step: "migrate", status: "running", migration: "0002_b" },
      { step: "migrate", status: "done", migration: "0002_b" },
      { step: "settings", status: "running" },
      { step: "settings", status: "done", count: 2 },
      { step: "record", status: "running" },
      { step: "record", status: "done" },
    ]);
  });

  it("再啟用一次(套用更新):跑過的 migration 略過,已有的設定不重寫", async () => {
    await enableExtension("demo");
    const events = await enableAndCollect();
    expect(events).toContainEqual({ step: "migrate", status: "skipped" });
    expect(events).toContainEqual({ step: "settings", status: "done", count: 0 });
  });
});

describe("pendingCodeUpgrades", () => {
  it("有 migration 沒跑、或資料庫記的是舊版號,才列出來", async () => {
    await enableExtension("demo");
    expect((await pendingCodeUpgrades()).size).toBe(0);

    await d1().prepare("DELETE FROM ext_migrations WHERE id = 'demo:0002_b'").run();
    expect((await pendingCodeUpgrades()).get("demo")).toEqual({ from: "1.1.0", to: "1.1.0", migrations: ["0002_b"] });

    await enableExtension("demo");
    await d1().prepare("UPDATE extensions SET version = '1.0.0' WHERE id = 'demo'").run();
    expect((await pendingCodeUpgrades()).get("demo")).toEqual({ from: "1.0.0", to: "1.1.0", migrations: [] });

    await d1().prepare("UPDATE extensions SET enabled = 0 WHERE id = 'demo'").run();
    expect((await pendingCodeUpgrades()).size).toBe(0);
  });
});

describe("EnableProgress steps", () => {
  it("全新啟用:佔位的「更新資料表」換成實際的 migration", () => {
    let steps = initialSteps(null);
    expect(steps.map((s) => s.key)).toEqual(["check", "migrate", "settings", "record"]);
    steps = applyStepEvent(steps, { step: "check", status: "done" });
    steps = applyStepEvent(steps, { step: "migrate", status: "running", migration: "0001_a" });
    expect(steps.map((s) => `${s.key}:${s.status}`)).toEqual([
      "check:done",
      "migrate:0001_a:running",
      "settings:waiting",
      "record:waiting",
    ]);
    steps = applyStepEvent(steps, { step: "settings", status: "done", count: 2 });
    expect(steps.find((s) => s.key === "settings")).toMatchObject({ status: "done", count: 2 });
  });

  it("套用更新:已知的 migration 一個一列;沒有要跑的就全部略過", () => {
    const steps = initialSteps(["0003_payment_fields"]);
    expect(steps.map((s) => s.key)).toContain("migrate:0003_payment_fields");
    const skipped = applyStepEvent(initialSteps(null), { step: "migrate", status: "skipped" });
    expect(skipped.find((s) => s.key === "migrate")?.status).toBe("skipped");
  });

  it("卡片上的 migration 合成一列「更新資料表」,不列出 migration id", () => {
    let steps = initialSteps(["0001_a", "0002_b"]);
    const rows = () => receiptSteps(steps).map((s) => `${s.key}:${s.status}`);
    expect(rows()).toEqual(["check:waiting", "migrate:waiting", "settings:waiting", "record:waiting"]);
    expect(receiptSteps(steps).some((s) => s.migration)).toBe(false);
    steps = applyStepEvent(steps, { step: "migrate", status: "done", migration: "0001_a" });
    expect(rows()).toContain("migrate:running");
    steps = applyStepEvent(steps, { step: "migrate", status: "done", migration: "0002_b" });
    expect(rows()).toContain("migrate:done");
    expect(receiptSteps(markFailed(applyStepEvent(initialSteps(["0003"]), { step: "migrate", status: "running", migration: "0003" })))
      .find((s) => s.status === "failed")?.key).toBe("migrate");
    expect(receiptSteps(applyStepEvent(initialSteps(null), { step: "migrate", status: "skipped" })).map((s) => s.key))
      .toEqual(["check", "migrate", "settings", "record"]);
  });

  it("失敗:進行中的那一步標成失敗;還沒開始就標第一步", () => {
    const running = applyStepEvent(initialSteps(["0003"]), { step: "migrate", status: "running", migration: "0003" });
    expect(markFailed(running).find((s) => s.status === "failed")?.key).toBe("migrate:0003");
    expect(markFailed(initialSteps(null))[0].status).toBe("failed");
  });
});

describe("enable steps one request at a time", () => {
  it("check 回報還沒跑的 migration;migrate 跑過的回 skipped;沒宣告的 id 丟錯", async () => {
    expect(await enableStepCheck("demo")).toEqual({ migrations: ["0001_a", "0002_b"] });
    expect(await enableStepMigrate("demo", "0001_a")).toBe("applied");
    expect(await enableStepMigrate("demo", "0001_a")).toBe("skipped");
    expect(await enableStepCheck("demo")).toEqual({ migrations: ["0002_b"] });
    await expect(enableStepMigrate("demo", "9999_nope")).rejects.toThrow();
  });

  it("進度卡以伺服器當下的清單為準", () => {
    const stale = initialSteps(["0001_a", "0002_b"]);
    expect(withMigrations(stale, ["0002_b"]).map((s) => s.key)).toEqual(["check", "migrate:0002_b", "settings", "record"]);
    expect(withMigrations(stale, []).map((s) => s.key)).toEqual(["check", "migrate", "settings", "record"]);
  });
});

