import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("@/../extensions/registry", () => ({ registry: [] }));
vi.mock("@/ext/loader", () => ({
  invalidateExtRuntimeMemo: () => undefined,
  getExtRuntime: async () => ({
    hooks: { doAction: async () => undefined },
  }),
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => undefined }));
// 模擬「讀的時候還是啟用、寫的時候剛被停用」:讓 manager 讀到過時的已安裝清單。
const staleRead = vi.hoisted(() => ({ enabled: null as null | string[] }));
vi.mock("@/ext/installed-plugins", async (importActual) => {
  const actual = await importActual<typeof import("../src/ext/installed-plugins")>();
  return {
    ...actual,
    listInstalledPlugins: async (...args: Parameters<typeof actual.listInstalledPlugins>) => {
      const plugins = await actual.listInstalledPlugins(...args);
      const stale = staleRead.enabled;
      return stale ? plugins.map((p) => (stale.includes(p.id) ? { ...p, enabled: true } : p)) : plugins;
    },
  };
});

import {
  disableDeclarative,
  enableDeclarative,
  uninstallDeclarative,
} from "../src/ext/manager";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);" +
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);" +
      // 1.50.0:停用前會查「誰需要它」,兩種插件都看。
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  staleRead.enabled = null;
  await d1().exec(
    "DELETE FROM declarative_extensions; DELETE FROM ext_migrations; DELETE FROM settings; DELETE FROM contents;",
  );
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id,manifest,version,enabled,installed_at,updated_at) VALUES ('demo','{}','1.0.0',1,100,100)",
    )
    .run();
});

describe("declarative manager revision lifecycle", () => {
  it("advances revision through disable and enable claims", async () => {
    await disableDeclarative("demo");
    const disabled = await d1()
      .prepare("SELECT enabled, updated_at FROM declarative_extensions WHERE id='demo'")
      .first<{ enabled: number; updated_at: number }>();
    expect(disabled?.enabled).toBe(0);
    expect(disabled!.updated_at).toBeGreaterThan(100);

    await enableDeclarative("demo");
    const enabled = await d1()
      .prepare("SELECT enabled, updated_at FROM declarative_extensions WHERE id='demo'")
      .first<{ enabled: number; updated_at: number }>();
    expect(enabled?.enabled).toBe(1);
    expect(enabled!.updated_at).toBeGreaterThan(disabled!.updated_at);
  });

  it("removes positional migrations but retains a revision tombstone", async () => {
    await d1()
      .prepare(
        "INSERT INTO ext_migrations (id,ext_id,applied_at) VALUES ('demo:0000','demo',100),('demo:install:99','demo',100)",
      )
      .run();
    await uninstallDeclarative("demo", false);
    const row = await d1()
      .prepare("SELECT id FROM declarative_extensions WHERE id='demo'")
      .first();
    const markers = await d1()
      .prepare("SELECT id FROM ext_migrations WHERE ext_id='demo' ORDER BY id")
      .all<{ id: string }>();
    expect(row).toBeNull();
    expect(markers.results.every((marker) => marker.id.includes(":install:"))).toBe(
      true,
    );
    expect(markers.results.length).toBeGreaterThan(0);
  });
});

// 1.50.0:宣告式插件的 requiresExtensions —— 必要插件沒裝或停用時不能啟用。
describe("declarative enable checks required plugins", () => {
  const needy = (requires: unknown[]) =>
    JSON.stringify({ kind: "declarative", id: "needy", name: "Needy", version: "1.0.0", coreApi: "^1.50.0", requiresExtensions: requires });

  async function insert(id: string, manifest: string, enabled: 0 | 1) {
    await d1()
      .prepare("INSERT INTO declarative_extensions (id,manifest,version,enabled,installed_at,updated_at) VALUES (?,?,'1.0.0',?,100,100)")
      .bind(id, manifest, enabled)
      .run();
  }

  it("refuses while a required plugin is missing, names it, and leaves the row disabled", async () => {
    await insert("needy", needy([{ id: "stock" }, { id: "points", optional: true }]), 0);
    await expect(enableDeclarative("needy")).rejects.toThrow("請先安裝必要插件：stock");
    const row = await d1().prepare("SELECT enabled FROM declarative_extensions WHERE id='needy'").first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("asks to enable a required plugin that is installed but disabled, by its name", async () => {
    await insert("needy", needy([{ id: "stock" }]), 0);
    await insert("stock", JSON.stringify({ kind: "declarative", id: "stock", name: "Stock room", version: "1.0.0", coreApi: "^1.0.0" }), 0);
    await expect(enableDeclarative("needy")).rejects.toThrow("請先啟用必要插件：Stock room");
    await enableDeclarative("stock");
    await enableDeclarative("needy");
    const row = await d1().prepare("SELECT enabled FROM declarative_extensions WHERE id='needy'").first<{ enabled: number }>();
    expect(row?.enabled).toBe(1);
  });
});

// 1.50.0:啟用中的插件非選用地需要它 → 不能停用、不能移除(與程式碼插件之間的規則相同)。
describe("a plugin that another enabled plugin needs", () => {
  const stock = JSON.stringify({ kind: "declarative", id: "stock", name: "Stock room", version: "1.0.0", coreApi: "^1.0.0" });
  const needing = (id: string, requires: unknown[]) =>
    JSON.stringify({ kind: "declarative", id, name: { en: "Reviews", "zh-Hant": "評論" }, version: "1.0.0", coreApi: "^1.50.0", requiresExtensions: requires });

  async function insert(id: string, manifest: string, enabled: 0 | 1) {
    await d1()
      .prepare("INSERT INTO declarative_extensions (id,manifest,version,enabled,installed_at,updated_at) VALUES (?,?,'1.0.0',?,100,100)")
      .bind(id, manifest, enabled)
      .run();
  }
  const enabledOf = async (id: string) =>
    (await d1().prepare("SELECT enabled FROM declarative_extensions WHERE id=?").bind(id).first<{ enabled: number }>())?.enabled;

  it("cannot be disabled or removed while that plugin is enabled, and says which one", async () => {
    await insert("stock", stock, 1);
    await insert("reviews", needing("reviews", [{ id: "stock" }]), 1);
    await expect(disableDeclarative("stock")).rejects.toThrow("這些插件需要它，請先停用：");
    await expect(uninstallDeclarative("stock", true)).rejects.toThrow("這些插件需要它");
    expect(await enabledOf("stock")).toBe(1);

    await disableDeclarative("reviews");
    await disableDeclarative("stock");
    expect(await enabledOf("stock")).toBe(0);
  });

  it("an optional need or a need for a different plugin with the same id does not block", async () => {
    await insert("stock", JSON.stringify({ ...JSON.parse(stock), identity: "acme/stock", coreApi: "^1.50.0" }), 1);
    await insert("reviews", needing("reviews", [{ id: "stock", optional: true }]), 1);
    await insert("ratings", needing("ratings", [{ id: "stock", identity: "other/stock" }]), 1);
    await uninstallDeclarative("stock", false);
    expect(await d1().prepare("SELECT id FROM declarative_extensions WHERE id='stock'").first()).toBeNull();
  });

  it("a required plugin disabled between the check and the write still blocks, and leaves no claim behind", async () => {
    await insert("stock", stock, 0);
    await insert("reviews", needing("reviews", [{ id: "stock" }]), 0);
    staleRead.enabled = ["stock"];
    await expect(enableDeclarative("reviews")).rejects.toThrow("必要插件剛被停用");
    staleRead.enabled = null;
    expect(await enabledOf("reviews")).toBe(0);
    const claims = await d1().prepare("SELECT id FROM ext_migrations WHERE ext_id='reviews'").all();
    expect(claims.results).toEqual([]);
    await enableDeclarative("stock");
    await enableDeclarative("reviews");
    expect(await enabledOf("reviews")).toBe(1);
  });
});
