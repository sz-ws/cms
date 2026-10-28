import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

// 部署後自動套用程式碼插件的更新(manager.applyPendingCodeUpgrades、recordCodeSignature)
// 與程式碼簽名(code-signature.ts)。loader 什麼時候呼叫它們,見 ext-runtime-safety.test.ts。

const exts = vi.hoisted(() => ({
  demo: {
    id: "demo",
    name: "Demo",
    version: "1.1.0",
    coreApi: "^1.0.0",
    migrations: [
      { id: "0001_a", sql: "CREATE TABLE IF NOT EXISTS demo_a (id TEXT)" },
      { id: "0002_b", sql: "CREATE TABLE IF NOT EXISTS demo_b (id TEXT)" },
    ],
    settings: [{ key: "mode", label: "Mode", type: "text", default: "a" }],
  },
  broken: {
    id: "broken",
    name: "Broken",
    version: "2.0.0",
    coreApi: "^1.0.0",
    migrations: [{ id: "0001_bad", sql: "CREATE TABLE IF NOT EXISTS (" }],
  },
  racer: {
    id: "racer",
    name: "Racer",
    version: "1.0.0",
    coreApi: "^1.0.0",
    // 沒有 IF NOT EXISTS:第二個同時套用的人一定會失敗。
    migrations: [{ id: "0001_t", sql: "CREATE TABLE racer_t (id TEXT)" }],
  },
}));
const hookCalls = vi.hoisted(() => ({ doAction: vi.fn(async () => undefined) }));

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("@/../extensions/registry", () => ({ registry: [exts.demo, exts.broken, exts.racer] }));
vi.mock("@/ext/loader", () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({ hooks: { doAction: hookCalls.doAction } }),
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));

import {
  applyPendingCodeUpgrades,
  enableExtension,
  pendingCodeUpgrades,
  recordCodeSignature,
} from "../src/ext/manager";
import { CODE_SIGNATURE_KEY, codeSignature } from "../src/ext/code-signature";

const d1 = () => (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec(
    "DELETE FROM extensions; DELETE FROM ext_migrations; DELETE FROM settings; DROP TABLE IF EXISTS racer_t;",
  );
  hookCalls.doAction.mockClear();
});

async function rowVersion(id: string): Promise<string | null> {
  const row = await d1().prepare("SELECT version FROM extensions WHERE id = ?").bind(id).first<{ version: string }>();
  return row?.version ?? null;
}

describe("codeSignature", () => {
  it("版號或 migration 不同,簽名就不同;順序不影響", () => {
    const base = [exts.demo, exts.racer];
    expect(codeSignature(base)).toBe(codeSignature([exts.racer, exts.demo]));
    expect(codeSignature(base)).not.toBe(codeSignature([{ ...exts.demo, version: "1.2.0" }, exts.racer]));
    expect(codeSignature(base)).not.toBe(
      codeSignature([{ ...exts.demo, migrations: [...exts.demo.migrations, { id: "0003_c", sql: "" }] }, exts.racer]),
    );
  });
});

describe("applyPendingCodeUpgrades", () => {
  it("部署了新版號:記下新版號,不發 ext:enabled", async () => {
    await enableExtension("demo");
    await d1().prepare("UPDATE extensions SET version = '1.0.0' WHERE id = 'demo'").run();
    hookCalls.doAction.mockClear();

    expect(await applyPendingCodeUpgrades()).toEqual({ applied: ["demo"], failed: [] });
    expect(await rowVersion("demo")).toBe("1.1.0");
    expect((await pendingCodeUpgrades()).size).toBe(0);
    expect(hookCalls.doAction).not.toHaveBeenCalled();
  });

  it("新的 migration 自動跑完,新設定補上預設值", async () => {
    await enableExtension("demo");
    await d1().exec("DELETE FROM ext_migrations WHERE id = 'demo:0002_b'; DELETE FROM settings;");

    expect((await applyPendingCodeUpgrades()).applied).toEqual(["demo"]);
    const applied = await d1().prepare("SELECT id FROM ext_migrations WHERE ext_id = 'demo' ORDER BY id").all<{ id: string }>();
    expect(applied.results.map((r) => r.id)).toEqual(["demo:0001_a", "demo:0002_b"]);
    const mode = await d1().prepare("SELECT value FROM settings WHERE key = 'ext.demo.mode'").first<{ value: string }>();
    expect(mode?.value).toBe(JSON.stringify("a"));
  });

  it("沒啟用的插件不動", async () => {
    expect(await applyPendingCodeUpgrades()).toEqual({ applied: [], failed: [] });
    expect(await rowVersion("demo")).toBeNull();
  });

  it("一個插件失敗,其他照樣套用;失敗的留著給人按「套用更新」", async () => {
    await enableExtension("demo");
    await d1()
      .prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('broken', 1, '1.0.0', 1, 1)")
      .run();
    await d1().prepare("UPDATE extensions SET version = '1.0.0' WHERE id = 'demo'").run();

    const result = await applyPendingCodeUpgrades();
    expect(result.applied).toEqual(["demo"]);
    expect(result.failed).toEqual(["broken"]);
    expect(await rowVersion("demo")).toBe("1.1.0");
    expect(await rowVersion("broken")).toBe("1.0.0");
    expect((await pendingCodeUpgrades()).has("broken")).toBe(true);
  });

  it("兩個 isolate 同時套用同一個 migration:晚到的當作已套用,不算失敗", async () => {
    await d1()
      .prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('racer', 1, '1.0.0', 1, 1)")
      .run();

    const [first, second] = await Promise.all([applyPendingCodeUpgrades(), applyPendingCodeUpgrades()]);
    expect([...first.failed, ...second.failed]).toEqual([]);
    const rows = await d1().prepare("SELECT id FROM ext_migrations WHERE ext_id = 'racer'").all();
    expect(rows.results).toHaveLength(1);
  });
});

describe("recordCodeSignature", () => {
  it("寫進 settings,再寫一次是覆蓋", async () => {
    await recordCodeSignature("a");
    await recordCodeSignature("b");
    const row = await d1().prepare("SELECT value FROM settings WHERE key = ?").bind(CODE_SIGNATURE_KEY).first<{ value: string }>();
    expect(row?.value).toBe(JSON.stringify("b"));
  });
});
