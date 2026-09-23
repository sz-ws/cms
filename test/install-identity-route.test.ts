import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Extension } from "../src/ext/types";

// 1.50.0:POST /api/registry/install 的插件身分與相依。
//   - identity 裝上之後不能換(identity_mismatch),換來源不影響
//   - 沒有 identity 的舊安裝:換來源要確認(source_changed + confirmSource)
//   - 必要插件沒裝或停用 → 409 missing_extensions,回 id
// 來源抓取以 mock 的 registry-client 代替(不打網路);其餘走真的 D1。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ id: "u-admin", email: "a@t.co", name: "A", role: "admin" as const }),
  };
});
vi.mock("@/lib/security", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/security")>();
  return { ...actual, assertSameOrigin: () => {} };
});

const SOURCE_A = "https://registry-a.test";
const SOURCE_B = "https://registry-b.test";
const registryState = vi.hoisted(() => ({
  manifests: new Map<string, unknown>(),
}));
vi.mock("@/lib/registry-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/registry-client")>();
  return {
    ...actual,
    assertKnownRegistrySource: async (source: string) => {
      if (source !== "https://registry-a.test" && source !== "https://registry-b.test") {
        throw new actual.UnknownRegistrySource(source);
      }
    },
    fetchManifest: async (source: string, id: string) => {
      const manifest = registryState.manifests.get(`${source}|${id}`);
      if (!manifest) throw new Error("http 404");
      return manifest;
    },
    sourceAllowsScripts: async () => false,
  };
});

const rtState = vi.hoisted(() => ({ all: [] as Extension[] }));
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    all: rtState.all,
    enabled: [],
    byId: () => undefined,
    hooks: { doAction: async () => {}, applyFilters: async (_n: string, v: unknown) => v },
  }),
  invalidateExtRuntimeMemo: () => {},
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => {} }));

import { POST } from "../src/app/api/registry/install/route";

const d1 = () => (env as { DB: D1Database }).DB;

const post = (body: unknown) =>
  POST(
    new Request("https://cms.test/api/registry/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

function manifest(extra: Record<string, unknown> = {}, id = "reviews") {
  return { kind: "declarative", id, name: id, version: "1.0.0", coreApi: "^1.50.0", ...extra };
}

function publish(source: string, m: { id: string }) {
  registryState.manifests.set(`${source}|${m.id}`, m);
}

async function row(id = "reviews") {
  return d1()
    .prepare("SELECT version, source, manifest FROM declarative_extensions WHERE id = ?")
    .bind(id)
    .first<{ version: string; source: string | null; manifest: string }>();
}

beforeAll(async () => {
  await d1().batch(
    [
      "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
      "CREATE TABLE IF NOT EXISTS ext_migrations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, applied_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    ].map((sql) => d1().prepare(sql)),
  );
});

beforeEach(async () => {
  await d1().batch(
    [
      "DELETE FROM declarative_extensions;",
      "DELETE FROM ext_migrations;",
      "DELETE FROM settings;",
      "DELETE FROM login_attempts;",
      "DELETE FROM extensions;",
    ].map((sql) => d1().prepare(sql)),
  );
  registryState.manifests.clear();
  rtState.all = [];
});

describe("install: identity is fixed once installed", () => {
  it("refuses an update whose identity differs, and one that drops it", async () => {
    publish(SOURCE_A, manifest({ identity: "acme/reviews" }));
    expect((await post({ id: "reviews", source: SOURCE_A })).status).toBe(200);

    publish(SOURCE_B, manifest({ identity: "other/reviews", version: "2.0.0" }));
    const res = await post({ id: "reviews", source: SOURCE_B });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "identity_mismatch",
      installed: "acme/reviews",
      incoming: "other/reviews",
    });

    publish(SOURCE_A, manifest({ version: "2.0.0" }));
    const dropped = await post({ id: "reviews", source: SOURCE_A });
    expect(dropped.status).toBe(409);
    expect(await dropped.json()).toMatchObject({ error: "identity_mismatch", incoming: null });

    // 兩次都沒寫入:仍是第一次裝的那一份。
    expect(await row()).toMatchObject({ version: "1.0.0", source: SOURCE_A });
  });

  it("confirmSource cannot override an identity mismatch", async () => {
    publish(SOURCE_A, manifest({ identity: "acme/reviews" }));
    await post({ id: "reviews", source: SOURCE_A });
    publish(SOURCE_B, manifest({ identity: "other/reviews" }));
    const res = await post({ id: "reviews", source: SOURCE_B, confirmSource: SOURCE_A });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe("identity_mismatch");
  });

  it("the same identity may come from another source (a registry that moved)", async () => {
    publish(SOURCE_A, manifest({ identity: "acme/reviews" }));
    await post({ id: "reviews", source: SOURCE_A });
    publish(SOURCE_B, manifest({ identity: "acme/reviews", version: "1.1.0" }));
    expect((await post({ id: "reviews", source: SOURCE_B })).status).toBe(200);
    expect(await row()).toMatchObject({ version: "1.1.0", source: SOURCE_B });
    expect(JSON.parse((await row())!.manifest).identity).toBe("acme/reviews");
  });
});

describe("install: plugins installed before identities existed", () => {
  it("updates from the same source keep working and record the new identity", async () => {
    publish(SOURCE_A, manifest({}, "reviews"));
    await post({ id: "reviews", source: SOURCE_A });
    publish(SOURCE_A, manifest({ identity: "acme/reviews", version: "1.1.0" }));
    expect((await post({ id: "reviews", source: SOURCE_A })).status).toBe(200);
    expect(JSON.parse((await row())!.manifest).identity).toBe("acme/reviews");
  });

  it("another source needs the admin to confirm the source being replaced", async () => {
    publish(SOURCE_A, manifest());
    await post({ id: "reviews", source: SOURCE_A });
    publish(SOURCE_B, manifest({ version: "3.0.0" }));

    const refused = await post({ id: "reviews", source: SOURCE_B });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "source_changed", installedSource: SOURCE_A });
    expect(await row()).toMatchObject({ version: "1.0.0", source: SOURCE_A });

    // 確認的必須是「被取代的那個來源」,不是隨便一個值。
    expect((await post({ id: "reviews", source: SOURCE_B, confirmSource: SOURCE_B })).status).toBe(409);
    expect((await post({ id: "reviews", source: SOURCE_B, confirmSource: SOURCE_A })).status).toBe(200);
    expect(await row()).toMatchObject({ version: "3.0.0", source: SOURCE_B });
  });
});

describe("install: required plugins", () => {
  const needy = manifest({
    requiresExtensions: [
      { id: "shop", reason: "Reviews belong to products." },
      { id: "stock" },
      { id: "points", optional: true },
    ],
  });

  async function installStock(enabled: 0 | 1, identity?: string) {
    const stock = manifest(identity ? { identity } : {}, "stock");
    await d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at) VALUES ('stock', ?, '1.0.0', ?, ?, 1, 1)",
      )
      .bind(JSON.stringify(stock), enabled, SOURCE_A)
      .run();
  }

  async function enableShop(enabled: 0 | 1) {
    rtState.all = [{ id: "shop", name: "Shop", version: "0.5.0", coreApi: "^1.49.0" }];
    await d1().prepare("INSERT INTO extensions (id, enabled, installed_at) VALUES ('shop', ?, 1)").bind(enabled).run();
  }

  it("refuses with the ids of every missing one (optional ones do not count)", async () => {
    publish(SOURCE_A, needy);
    const res = await post({ id: "reviews", source: SOURCE_A });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; missing: string[]; details: unknown[] }>();
    expect(body.error).toBe("missing_extensions");
    expect(body.missing).toEqual(["shop", "stock"]);
    expect(body.details).toEqual([
      { id: "shop", state: "missing" },
      { id: "stock", state: "missing" },
    ]);
    expect(await row()).toBeNull();
  });

  it("a disabled required plugin still blocks", async () => {
    publish(SOURCE_A, needy);
    await enableShop(1);
    await installStock(0);
    const res = await post({ id: "reviews", source: SOURCE_A });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ missing: ["stock"], details: [{ id: "stock", state: "disabled" }] });
  });

  it("a code plugin that is compiled in but not enabled blocks too", async () => {
    publish(SOURCE_A, needy);
    await enableShop(0);
    await installStock(1);
    const res = await post({ id: "reviews", source: SOURCE_A });
    expect(await res.json()).toMatchObject({ missing: ["shop"], details: [{ id: "shop", state: "disabled" }] });
  });

  it("installs once every required plugin is installed and enabled", async () => {
    publish(SOURCE_A, needy);
    await enableShop(1);
    await installStock(1);
    expect((await post({ id: "reviews", source: SOURCE_A })).status).toBe(200);
  });

  it("a required identity must match the installed plugin when both have one", async () => {
    publish(
      SOURCE_A,
      manifest({ requiresExtensions: [{ id: "stock", identity: "acme/stock" }] }),
    );
    await installStock(1, "other/stock");
    const res = await post({ id: "reviews", source: SOURCE_A });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: [{ id: "stock", state: "different" }] });

    await d1().prepare("DELETE FROM declarative_extensions WHERE id = 'stock'").run();
    await installStock(1, "acme/stock");
    expect((await post({ id: "reviews", source: SOURCE_A })).status).toBe(200);
  });
});
