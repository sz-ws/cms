import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// core 1.74.0:網站本身的一層(Extension.layer)編進來就生效,不看 extensions 表。後台與相依檢查要跟著認得它:
// 不能停用、不能移除;別的插件需要它時算已啟用;它自己需要的插件不能被停用;有 migration 沒跑才列進待套用。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
const deployed = vi.hoisted(() => ({ extensions: [] as Extension[] }));
vi.mock("@/../extensions/registry", () => ({
  get registry() {
    return deployed.extensions;
  },
}));
vi.mock("@/ext/loader", () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({
    enabled: deployed.extensions,
    all: deployed.extensions,
    byId: (id: string) => deployed.extensions.find((ext) => ext.id === id),
    hooks: { doAction: async () => undefined },
  }),
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => undefined, redirect: () => undefined, notFound: () => undefined }));

import { ExtensionLifecycleConflict, assertCodeDependencies, writeCodeDisabled } from "../src/ext/code-lifecycle";
import { disableExtension, pendingCodeUpgrades, uninstallExtension } from "../src/ext/manager";

const d1 = () => (env as { DB: D1Database }).DB;

const plugin = (id: string, more: Partial<Extension> = {}): Extension => ({ id, name: id, version: "1.0.0", coreApi: "^1.0.0", ...more });

async function enabledRow(id: string, version = "1.0.0", enabled = 1): Promise<void> {
  await d1().prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(id, enabled, version).run();
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions; DELETE FROM declarative_extensions; DELETE FROM ext_migrations; DELETE FROM settings;");
  deployed.extensions = [];
});

describe("網站本身的一層不能在後台停用或移除", () => {
  it("停用被擋下來,資料庫沒有變", async () => {
    deployed.extensions = [plugin("the-site", { layer: "site" })];
    await enabledRow("the-site");

    await expect(disableExtension("the-site")).rejects.toBeInstanceOf(ExtensionLifecycleConflict);
    await expect(disableExtension("the-site")).rejects.toThrow("這是網站本身的一部分，不能停用。");
    expect(await d1().prepare("SELECT enabled FROM extensions WHERE id = 'the-site'").first()).toEqual({ enabled: 1 });
  });

  it("移除被擋下來,它的設定還在", async () => {
    deployed.extensions = [plugin("the-site", { layer: "site" })];
    await enabledRow("the-site");
    await d1().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('ext.the-site.marquee', '\"hello\"', 1)").run();

    await expect(uninstallExtension("the-site")).rejects.toThrow("這是網站本身的一部分，不能移除。");
    expect(await d1().prepare("SELECT value FROM settings WHERE key = 'ext.the-site.marquee'").first()).toEqual({ value: '"hello"' });
    expect(await d1().prepare("SELECT enabled FROM extensions WHERE id = 'the-site'").first()).toEqual({ enabled: 1 });
  });
});

describe("待套用的更新", () => {
  it("一層沒有 extensions 列也沒有 migration:沒有東西要套用", async () => {
    deployed.extensions = [plugin("the-agency", { layer: "agency" })];
    expect([...(await pendingCodeUpgrades()).keys()]).toEqual([]);
  });

  it("一層有還沒跑的 migration:列出來,就算它沒有 extensions 列", async () => {
    deployed.extensions = [plugin("the-site", { layer: "site", migrations: [{ id: "0001_notes", sql: "CREATE TABLE ext_the_site_notes (id TEXT PRIMARY KEY)" }] })];
    expect(Object.fromEntries(await pendingCodeUpgrades())).toEqual({
      "the-site": { from: "1.0.0", to: "1.0.0", migrations: ["0001_notes"] },
    });
  });

  it("一層只是表裡記的版號比較舊:不用人按", async () => {
    deployed.extensions = [plugin("the-site", { layer: "site", version: "1.1.0" })];
    await enabledRow("the-site", "1.0.0");
    expect([...(await pendingCodeUpgrades()).keys()]).toEqual([]);
  });

  it("一般插件照舊:版號比較舊就列出來,沒啟用的不列", async () => {
    deployed.extensions = [plugin("shop", { version: "1.1.0" }), plugin("blog", { version: "1.1.0" })];
    await enabledRow("shop", "1.0.0");
    await enabledRow("blog", "1.0.0", 0);
    expect(Object.fromEntries(await pendingCodeUpgrades())).toEqual({
      shop: { from: "1.0.0", to: "1.1.0", migrations: [] },
    });
  });
});

describe("相依", () => {
  it("需要一層的插件可以啟用:那一層一直是開著的,不用有 extensions 列", async () => {
    const agency = plugin("the-agency", { layer: "agency" });
    const report = plugin("report", { requiresExtensions: ["the-agency"] });
    await expect(assertCodeDependencies(d1(), report, [agency, report])).resolves.toBeUndefined();
  });

  it("需要一般插件的照舊:沒啟用就擋", async () => {
    const shop = plugin("shop");
    const report = plugin("report", { requiresExtensions: ["shop"] });
    await enabledRow("shop", "1.0.0", 0);
    await expect(assertCodeDependencies(d1(), report, [shop, report])).rejects.toBeInstanceOf(ExtensionLifecycleConflict);
  });

  it("一層需要的插件不能停用", async () => {
    const shop = plugin("shop");
    const site = plugin("the-site", { layer: "site", requiresExtensions: ["shop"] });
    await enabledRow("shop");

    await expect(writeCodeDisabled(d1(), shop, [shop, site], 2)).rejects.toBeInstanceOf(ExtensionLifecycleConflict);
    expect(await d1().prepare("SELECT enabled FROM extensions WHERE id = 'shop'").first()).toEqual({ enabled: 1 });
  });
});
