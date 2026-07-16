import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// GET /api/registry/index 的 binding-backed 整合測試(miniflare D1)。
// 同既有測試(search.test.ts 等):mock @/lib/cf 讓 db()/getDB() 直接打到
// cloudflare:test 的 env.DB;mock @/lib/auth 讓 requireAuth 由測試控制。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

const authState = vi.hoisted(() => ({
  user: null as
    | null
    | { id: string; email: string; name: string; role: "admin" | "editor" },
}));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: "admin") => {
      if (!authState.user) throw new actual.AuthError(401);
      if (role && authState.user.role !== role)
        throw new actual.AuthError(403);
      return authState.user;
    },
  };
});

// registry.json 抓取全 mock(避免真的打網路)——entries 由每個測試自行指定。
const registryState = vi.hoisted(() => ({
  entries: [] as unknown[],
  errors: [] as unknown[],
}));
vi.mock("@/lib/registry-client", () => ({
  fetchRegistryIndex: async () => ({
    entries: registryState.entries,
    errors: registryState.errors,
  }),
}));

// @/ext/loader 全 mock(workers pool 地雷:loader 的相依鏈含 next/navigation,
// 靜態 import 會拖垮 test pool——見 ext-jobs.test.ts 同款註解)。rt.all 由每個
// 測試自行指定,模擬「這次部署編譯進 bundle 的 code extensions」。
const rtState = vi.hoisted(() => ({ all: [] as Extension[] }));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const hooks = new HookBus();
  const rt = {
    enabled: [] as Extension[],
    get all() {
      return rtState.all;
    },
    hooks,
    byId: () => undefined,
    isCompatible: () => true,
  };
  return { getExtRuntime: async () => rt };
});

import { GET } from "../src/app/api/registry/index/route";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const ADMIN = {
  id: "u-admin",
  email: "admin@test.com",
  name: "Admin",
  role: "admin" as const,
};
const EDITOR = {
  id: "u-editor",
  email: "editor@test.com",
  name: "Editor",
  role: "editor" as const,
};

const EXT_DDL =
  "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const DX_DDL =
  "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(EXT_DDL);
  await d1().exec(DX_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM extensions;");
  await d1().exec("DELETE FROM declarative_extensions;");
  authState.user = null;
  registryState.entries = [];
  registryState.errors = [];
  rtState.all = [];
});

async function insertExt(
  id: string,
  enabled: number,
  version: string,
): Promise<void> {
  const now = Date.now();
  await d1()
    .prepare(
      "INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, enabled, version, now, now)
    .run();
}

function fakeExt(id: string, version: string): Extension {
  return { id, name: id, version, coreApi: "^1.0.0" };
}

describe("GET /api/registry/index", () => {
  it("401 when unauthenticated", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("403 for a non-admin session", async () => {
    authState.user = EDITOR;
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("installedCode has one entry per bundle-compiled code extension, independent of registry.json entries", async () => {
    authState.user = ADMIN;
    // "cron" 有 DB 列(enabled=1,但 DB 版本落後於 bundle 版本 —— 模擬「已安裝但
    // 有更新」)。"other-code" 編譯進 bundle 但從未寫入 DB 列(模擬「新編譯進去、
    // 還沒 install/enable 過」)。
    await insertExt("cron", 1, "1.1.0");
    rtState.all = [fakeExt("cron", "1.2.0"), fakeExt("other-code", "0.9.0")];

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installedCode: { id: string; version: string; enabled: boolean }[];
    };
    expect(body.installedCode).toEqual([
      { id: "cron", version: "1.2.0", enabled: true },
      { id: "other-code", version: "0.9.0", enabled: false },
    ]);
  });

  it("marks an installed-but-disabled code extension as enabled:false", async () => {
    authState.user = ADMIN;
    await insertExt("cron", 0, "1.2.0");
    rtState.all = [fakeExt("cron", "1.2.0")];

    const res = await GET();
    const body = (await res.json()) as {
      installedCode: { id: string; version: string; enabled: boolean }[];
    };
    expect(body.installedCode).toEqual([
      { id: "cron", version: "1.2.0", enabled: false },
    ]);
  });

  it("installedCode is empty when no code extensions are compiled into the bundle", async () => {
    authState.user = ADMIN;
    rtState.all = [];

    const res = await GET();
    const body = (await res.json()) as { installedCode: unknown[] };
    expect(body.installedCode).toEqual([]);
  });

  it("does not change the existing entries/errors/services response shape", async () => {
    authState.user = ADMIN;
    registryState.entries = [
      {
        id: "cron",
        kind: "code",
        name: "Cron",
        version: "1.2.0",
        coreApi: "^1.0.0",
        source: "https://example.test",
      },
    ];
    rtState.all = [fakeExt("cron", "1.2.0")];

    const res = await GET();
    const body = (await res.json()) as {
      entries: { id: string; installed: boolean; installedVersion: string | null }[];
      errors: unknown[];
      services: unknown[];
      installedCode: unknown[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe("cron");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.installedCode)).toBe(true);
  });
});
