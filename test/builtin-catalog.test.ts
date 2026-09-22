import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// 1.49.0:商品目錄併進 commerce-kit。這裡驗三層:
//   1. kit 的開關邏輯(商店啟用 + ext.shop.catalog 沒關)
//   2. 對齊函式把 declarative_extensions 的 catalog 列建立 / 換新 / 停用
//   3. 真的 loader:部署後換上底座的 manifest、設定一改下一個 request 就生效
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const registryState = vi.hoisted(() => ({ entries: [] as Extension[] }));
vi.mock("@/../extensions/registry", () => ({ registry: registryState.entries }));

// 同 ext-runtime-safety.test.ts:interpret 是 .tsx,真的載入會把 next/link 拉進 workers
// 測試池。這裡只要知道 loader 有沒有把列交給它。
vi.mock("@/ext/dx/interpret", () => ({
  interpretManifest: (row: { id: string; manifest: string; version: string }) => ({
    status: "ok" as const,
    extension: { id: row.id, name: row.id, version: row.version, coreApi: "^1.0.0" } as unknown as Extension,
  }),
}));

import { catalogManifest, catalogWanted } from "../src/ext/commerce-kit/catalog";
import {
  builtinSignature,
  isBaseManaged,
  isBuiltinDeclarative,
  reconcileBuiltinDeclaratives,
} from "../src/ext/builtin-declaratives";
import { parseManifest } from "../src/ext/dx/manifest";
import { CORE_API_VERSION } from "../src/ext/version";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

type LoaderModule = typeof import("../src/ext/loader");
let loader: LoaderModule;
async function getLoader(): Promise<LoaderModule> {
  loader ??= await import("../src/ext/loader");
  return loader;
}

async function catalogRow(): Promise<{ manifest: string; version: string; enabled: number; source: string | null; updated_at: number } | null> {
  return d1()
    .prepare("SELECT manifest, version, enabled, source, updated_at FROM declarative_extensions WHERE id = 'catalog'")
    .first();
}

async function setting(key: string): Promise<string | null> {
  const row = await d1().prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function putSetting(key: string, value: unknown, at: number): Promise<void> {
  await d1()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), at)
    .run();
}

const shopExtension = { id: "shop", name: "shop", version: "0.5.0", coreApi: "^1.49.0" } as Extension;

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions; DELETE FROM declarative_extensions; DELETE FROM settings;");
  registryState.entries.splice(0);
  (await getLoader()).invalidateExtRuntimeMemo();
  const { invalidateSettingsCache } = await import("../src/lib/settings");
  invalidateSettingsCache();
});

describe("commerce-kit catalog", () => {
  it("ships a manifest the CMS accepts, versioned with the base", () => {
    const result = parseManifest(catalogManifest());
    expect(result.error).toBeUndefined();
    expect(result.manifest?.version).toBe(CORE_API_VERSION);
    const product = result.manifest?.contentTypes?.find((t) => t.name === "product");
    expect(product?.fields.find((f) => f.key === "category")).toMatchObject({ type: "relation", to: "catalog.category" });
  });

  it("is wanted only while the shop is enabled and the switch is not off", async () => {
    const read = vi.fn(async () => undefined as unknown);
    expect(await catalogWanted({ codeEnabled: new Set(), setting: read })).toBe(false);
    expect(read).not.toHaveBeenCalled();

    expect(await catalogWanted({ codeEnabled: new Set(["shop"]), setting: read })).toBe(true);
    expect(read).toHaveBeenCalledWith("ext.shop.catalog");

    expect(await catalogWanted({ codeEnabled: new Set(["shop"]), setting: async () => false })).toBe(false);
  });

  it("refuses to treat other ids as built-in", () => {
    expect(isBuiltinDeclarative("catalog")).toBe(true);
    expect(isBuiltinDeclarative("blog")).toBe(false);
  });

  it("counts a row as base-managed only once the base has written it", () => {
    expect(isBaseManaged("catalog", "builtin")).toBe(true);
    expect(isBaseManaged("catalog", "https://registry.example.test")).toBe(false);
    expect(isBaseManaged("blog", "builtin")).toBe(false);
  });
});

describe("reconcileBuiltinDeclaratives", () => {
  it("creates the row with its setting defaults, then leaves it alone", async () => {
    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", true]]), 1_000)).toBe(true);
    const row = await catalogRow();
    expect(row).toMatchObject({ version: CORE_API_VERSION, enabled: 1 });
    expect(JSON.parse(row!.manifest)).toEqual(catalogManifest());
    expect(await setting("ext.catalog.currency")).toBe('"TWD"');

    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", true]]), 2_000)).toBe(false);
    expect((await catalogRow())?.updated_at).toBe(1_000);
  });

  it("takes over a row installed from a registry without touching content or settings", async () => {
    await d1()
      .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES ('catalog', ?, '0.2.0', 1, 'https://registry.example.test', 500, 5000)")
      .bind(JSON.stringify({ ...catalogManifest(), version: "0.2.0" }))
      .run();
    await putSetting("ext.catalog.currency", "USD", 500);

    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", true]]), 1_000)).toBe(true);
    const row = await catalogRow();
    expect(row).toMatchObject({ version: CORE_API_VERSION, enabled: 1, source: "builtin" });
    // updated_at 往前走(不會比原本小),runtime stamp 才會變。
    expect(row!.updated_at).toBe(5_001);
    expect(await setting("ext.catalog.currency")).toBe('"USD"');
  });

  it("disables the row when it is not wanted and brings it back later", async () => {
    await reconcileBuiltinDeclaratives(new Map([["catalog", true]]), 1_000);
    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", false]]), 2_000)).toBe(true);
    expect((await catalogRow())?.enabled).toBe(0);
    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", false]]), 3_000)).toBe(false);

    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", true]]), 4_000)).toBe(true);
    expect((await catalogRow())?.enabled).toBe(1);
  });

  // 只拿商品目錄展示商品、沒有商店的站:registry 裝的那列底座不接手也不關,升級後照常運作。
  it("leaves a registry-installed catalog alone on a site without the shop", async () => {
    await d1()
      .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES ('catalog', '{}', '0.1.0', 1, 'https://raw.githubusercontent.com/sz-ws/registry/main', 500, 500)")
      .run();
    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", false]]), 1_000)).toBe(false);
    expect(await catalogRow()).toMatchObject({ enabled: 1, version: "0.1.0", updated_at: 500 });
  });

  it("does nothing on a site that never wanted it", async () => {
    expect(await reconcileBuiltinDeclaratives(new Map([["catalog", false]]))).toBe(false);
    expect(await catalogRow()).toBeNull();
  });

  it("fingerprints the wanted state", () => {
    expect(builtinSignature(new Map([["catalog", true]]))).toBe("catalog:1");
    expect(builtinSignature(new Map([["catalog", false]]))).toBe("catalog:0");
  });
});

describe("loader with the built-in catalog", () => {
  it("adds the catalog when the shop is enabled and follows the switch on the next request", async () => {
    registryState.entries.push(shopExtension);
    await d1()
      .prepare("INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('shop', 1, '0.5.0', 1, 1)")
      .run();
    const { getExtRuntime } = await getLoader();

    // 第一次載入就把列建好,讀到的就是它。
    const first = await getExtRuntime();
    expect(first.enabled.map((ext) => ext.id)).toEqual(["shop", "catalog"]);
    expect((await catalogRow())?.enabled).toBe(1);

    // 列已對齊:這次不寫入,memo 建起來。接下來只改設定,extension stamp 不變,
    // 要靠 builtinSig 對不上才會重新載入 —— 這才是正式環境關開關時走的路。
    const settled = await getExtRuntime();
    expect(settled.enabled.map((ext) => ext.id)).toEqual(["shop", "catalog"]);
    const { computeExtRuntimeStamp } = await import("../src/ext/runtime-stamp");
    const stampBefore = await computeExtRuntimeStamp();

    // 關掉開關:下一個 request 就不在 runtime 裡,列與內容保留。
    await putSetting("ext.shop.catalog", false, Date.now());
    expect(await computeExtRuntimeStamp()).toBe(stampBefore);
    const second = await getExtRuntime();
    expect(second.enabled.map((ext) => ext.id)).toEqual(["shop"]);
    expect((await catalogRow())?.enabled).toBe(0);

    await putSetting("ext.shop.catalog", true, Date.now() + 1);
    const third = await getExtRuntime();
    expect(third.enabled.map((ext) => ext.id)).toEqual(["shop", "catalog"]);
  });

  it("keeps the catalog out of a site without the shop", async () => {
    const rt = await (await getLoader()).getExtRuntime();
    expect(rt.enabled).toEqual([]);
    expect(await catalogRow()).toBeNull();
  });
});
