import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// loader 的資料庫路徑和 production 一樣走 D1；registry / migration helper 則用可控
// state 模擬，以驗證同一個 isolate 內 runtime memo 的真正行為。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const registryState = vi.hoisted(() => ({ entries: [] as Extension[] }));
const migrationState = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
}));

vi.mock("@/../extensions/registry", () => ({ registry: registryState.entries }));
vi.mock("@/ext/dx/declarative-migrate", () => ({
  runDeclarativeMigrations: migrationState.run,
}));

// interpret 必須 mock 掉。它是 .tsx 且會 import view 元件 → next/link,只要真的被
// 載入,整個 workers 測試池就在模組載入當下炸掉。既有測試全都是把 loader 整包
// mock 來迴避這件事,所以真正的 getExtRuntime() 從來沒被測過 —— 這支測試的目的
// 正是補上那個洞,故改為只 mock 這條相依鏈的源頭,loader 本身跑真的。
//
// 這樣的取捨是對的:本測試的主體是「loader 拿到各種 interpret 結果時怎麼把關」,
// 不是 interpret 自己的解析邏輯(那由 manifest.test.ts 覆蓋)。
vi.mock("@/ext/dx/interpret", () => ({
  interpretManifest: (row: { id: string; manifest: string; version: string }) => {
    const m = JSON.parse(row.manifest) as { coreApi?: string };
    const coreApi = typeof m.coreApi === "string" ? m.coreApi : "";
    // 與真實 interpret 同樣的把關順序:不相容在建立任何 runtime surface 之前擋下。
    if (!coreApi) return { status: "invalid" as const };
    if (!coreApi.startsWith("^1.")) {
      return { status: "incompatible" as const, coreApi };
    }
    return {
      status: "ok" as const,
      extension: {
        id: row.id,
        name: row.id,
        version: row.version,
        coreApi,
        publicRoutes: [{ pattern: `/${row.id}`, render: () => null }],
      } as unknown as Extension,
    };
  },
}));

// ⚠️ loader 只能**動態** import。頂層靜態 import 會把 interpret.tsx → view 元件 →
// next/link 整條 client 相依鏈拉進 workers 測試池,模組載入當下就炸
// (TypeError: Cannot read properties of undefined (reading '_'))。
// 既有測試一律走這個慣例(見 notify.test.ts / ext-jobs.test.ts):要嘛整包 mock,
// 要嘛在測試內 await import。
type LoaderModule = typeof import("../src/ext/loader");
let loader: LoaderModule;
async function getLoader(): Promise<LoaderModule> {
  loader ??= await import("../src/ext/loader");
  return loader;
}

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const now = 1_000;

function manifest(id: string, coreApi: string, migrations?: string[]): string {
  return JSON.stringify({
    kind: "declarative",
    id,
    name: id,
    version: "1.0.0",
    coreApi,
    contentTypes: [{ name: "item", fields: [] }],
    publicRoutes: [
      { pattern: `/${id}`, view: "list", contentType: "item" },
    ],
    ...(migrations ? { migrations } : {}),
  });
}

async function enableCode(id: string): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, 1, '1.0.0', ?, ?)",
    )
    .bind(id, now, now)
    .run();
}

async function enableDeclarative(id: string, value: string): Promise<void> {
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, stylesheet, installed_at, updated_at) VALUES (?, ?, '1.0.0', 1, NULL, NULL, ?, ?)",
    )
    .bind(id, value, now, now)
    .run();
}

function codeExtension(
  id: string,
  coreApi: string,
  onCreated: () => void,
): Extension {
  return {
    id,
    name: id,
    version: "1.0.0",
    coreApi,
    publicRoutes: [
      {
        match: (segments) => (segments[0] === id ? {} : null),
        component: () => null,
      },
    ],
    hooks: { "content:created": onCreated },
  };
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions; DELETE FROM declarative_extensions;");
  registryState.entries.splice(0);
  migrationState.run.mockReset();
  migrationState.run.mockResolvedValue(undefined);
  (await getLoader()).invalidateExtRuntimeMemo();
});

describe("extension runtime CORE_API boundary", () => {
  it("excludes an incompatible declarative extension while a healthy one keeps its routes", async () => {
    await enableDeclarative("old-dx", manifest("old-dx", "^2.0.0"));
    await enableDeclarative("healthy-dx", manifest("healthy-dx", "^1.0.0"));

    const rt = await (await getLoader()).getExtRuntime();

    expect(rt.enabled.map((ext) => ext.id)).toEqual(["healthy-dx"]);
    expect(rt.enabled.flatMap((ext) => ext.publicRoutes ?? [])).toHaveLength(1);
    expect(rt.unavailableById.get("old-dx")).toMatchObject({
      kind: "core-api-incompatible",
      coreApi: "^2.0.0",
    });
  });

  it("excludes an incompatible code extension without disabling a healthy extension hook or route", async () => {
    const incompatibleHook = vi.fn();
    const healthyHook = vi.fn();
    registryState.entries.push(
      codeExtension("old-code", "^2.0.0", incompatibleHook),
      codeExtension("healthy-code", "^1.0.0", healthyHook),
    );
    await enableCode("old-code");
    await enableCode("healthy-code");

    const rt = await (await getLoader()).getExtRuntime();
    await rt.hooks.doAction("content:created", { id: "entry" });

    expect(rt.enabled.map((ext) => ext.id)).toEqual(["healthy-code"]);
    expect(rt.enabled.flatMap((ext) => ext.publicRoutes ?? [])).toHaveLength(1);
    expect(healthyHook).toHaveBeenCalledTimes(1);
    expect(incompatibleHook).not.toHaveBeenCalled();
    expect(rt.unavailableById.get("old-code")).toMatchObject({
      kind: "core-api-incompatible",
      coreApi: "^2.0.0",
    });
  });

  it("keeps a migration failure unavailable and retries it on the later request", async () => {
    await enableDeclarative(
      "retry-dx",
      manifest("retry-dx", "^1.0.0", [
        "CREATE TABLE IF NOT EXISTS ext_retry_dx_items (id TEXT PRIMARY KEY)",
      ]),
    );
    await enableDeclarative("healthy-dx", manifest("healthy-dx", "^1.0.0"));
    migrationState.run
      .mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
      .mockResolvedValue(undefined);

    const first = await (await getLoader()).getExtRuntime();
    expect(first.enabled.map((ext) => ext.id)).toEqual(["healthy-dx"]);
    expect(first.unavailableById.get("retry-dx")).toEqual({
      kind: "migration-failed",
    });

    const second = await (await getLoader()).getExtRuntime();
    expect(migrationState.run).toHaveBeenCalledTimes(2);
    expect(new Set(second.enabled.map((ext) => ext.id))).toEqual(
      new Set(["retry-dx", "healthy-dx"]),
    );
    expect(second.unavailableById.has("retry-dx")).toBe(false);
  });
});
