import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.51.0:插件的前台編進網站之後,每一道 script 關卡的行為。
//   - 安裝 / 更新:來源沒開放 script、沒核准都照樣裝;舊的核准清掉
//   - 安裝前預覽:不回 script 資訊(商店不會開核准畫面)
//   - 已安裝的插件:不能再核准(409 scripts_compiled),列表狀態是 compiled
//   - CSP:被取代的 script 的主機不進白名單,包括編進去之前就核准過的
// 沒編進去的插件(plain)在同樣情境下照 1.50.0 擋下,當對照組。

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

const SOURCE = "https://registry.test";
const registryState = vi.hoisted(() => ({
  manifests: new Map<string, unknown>(),
  allowScripts: false,
}));
vi.mock("@/lib/registry-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/registry-client")>();
  return {
    ...actual,
    assertKnownRegistrySource: async (source: string) => {
      if (source !== "https://registry.test") throw new actual.UnknownRegistrySource(source);
    },
    fetchManifest: async (_source: string, id: string) => {
      const manifest = registryState.manifests.get(id);
      if (!manifest) throw new Error("http 404");
      return manifest;
    },
    sourceAllowsScripts: async () => registryState.allowScripts,
  };
});
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    all: [],
    enabled: [],
    byId: () => undefined,
    hooks: { doAction: async () => {}, applyFilters: async (_n: string, v: unknown) => v },
  }),
  invalidateExtRuntimeMemo: () => {},
}));
vi.mock("@/ext/dx/cache-invalidate", () => ({ revalidateExt: () => {} }));

import { overrideRegistry } from "../src/ext/overrides";
import { surfaceIds } from "../src/ext/dx/surfaces";
import { hashScripts } from "../src/ext/dx/scripts";
import {
  installedScriptsState,
  retireReplacedScriptApprovals,
  scriptsCompiledIn,
} from "../src/ext/dx/scripts-compiled";
import { parseManifest } from "../src/ext/dx/manifest";
import { approvedScriptHosts } from "../src/lib/public-csp";
import { POST as install } from "../src/app/api/registry/install/route";
import { GET as preview } from "../src/app/api/registry/manifest/route";
import { POST as scriptsAction } from "../src/app/api/extensions/[extId]/scripts/route";

const d1 = () => (env as { DB: D1Database }).DB;

const COMPILED = "proof";
const PLAIN = "plain";
const SCRIPTS = [{ src: "https://cdn.proof.test/w.js" }, { inline: "x()", domains: ["api.proof.test"] }];

function manifest(id: string, extra: Record<string, unknown> = {}) {
  return { kind: "declarative", id, name: id, version: "1.0.0", coreApi: "^1.51.0", scripts: SCRIPTS, ...extra };
}

const approval = async () => JSON.stringify({ hash: await hashScripts(SCRIPTS), by: "a@t.co", at: 1 });

const post = (body: unknown) =>
  install(
    new Request("https://cms.test/api/registry/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const approve = async (id: string) =>
  scriptsAction(
    new Request(`https://cms.test/api/extensions/${id}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", hash: await hashScripts(SCRIPTS) }),
    }),
    { params: Promise.resolve({ extId: id }) },
  );

async function row(id: string) {
  return d1()
    .prepare("SELECT scripts_approval AS approval, updated_at AS updatedAt FROM declarative_extensions WHERE id = ?")
    .bind(id)
    .first<{ approval: string | null; updatedAt: number }>();
}

async function insertInstalled(id: string, approvalJson: string | null, updatedAt = 5) {
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at, scripts_approval) VALUES (?, ?, '1.0.0', 1, ?, 1, ?, ?)",
    )
    .bind(id, JSON.stringify(manifest(id)), SOURCE, updatedAt, approvalJson)
    .run();
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
  if (!overrideRegistry.has(COMPILED, surfaceIds.publicScripts())) {
    overrideRegistry.register(COMPILED, surfaceIds.publicScripts(), "scripts", () => null);
  }
});

beforeEach(async () => {
  await d1().batch(
    ["DELETE FROM declarative_extensions;", "DELETE FROM ext_migrations;", "DELETE FROM settings;", "DELETE FROM login_attempts;"].map(
      (sql) => d1().prepare(sql),
    ),
  );
  registryState.manifests = new Map([
    [COMPILED, manifest(COMPILED)],
    [PLAIN, manifest(PLAIN)],
  ]);
  registryState.allowScripts = false;
});

describe("install with the compiled layer", () => {
  it("installs from a source that does not allow scripts, with nothing to approve", async () => {
    expect(scriptsCompiledIn(COMPILED)).toBe(true);
    expect(scriptsCompiledIn(PLAIN)).toBe(false);

    const refused = await post({ id: PLAIN, source: SOURCE });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "scripts_not_allowed" });

    const res = await post({ id: COMPILED, source: SOURCE });
    expect(res.status).toBe(200);
    expect((await row(COMPILED))?.approval).toBeNull();
  });

  it("does not ask for a review when the source allows scripts", async () => {
    registryState.allowScripts = true;
    const review = await post({ id: PLAIN, source: SOURCE });
    expect(review.status).toBe(409);
    expect(await review.json()).toMatchObject({ error: "scripts_review_required" });
    expect((await post({ id: COMPILED, source: SOURCE })).status).toBe(200);
  });

  it("an update clears an approval stored before the layer was compiled in", async () => {
    registryState.allowScripts = true;
    await insertInstalled(COMPILED, await approval());
    await insertInstalled(PLAIN, await approval());
    registryState.manifests.set(COMPILED, manifest(COMPILED, { version: "1.1.0" }));
    registryState.manifests.set(PLAIN, manifest(PLAIN, { version: "1.1.0" }));
    expect((await post({ id: COMPILED, source: SOURCE })).status).toBe(200);
    expect((await post({ id: PLAIN, source: SOURCE })).status).toBe(200);
    expect((await row(COMPILED))?.approval).toBeNull();
    // 沒編進去的:scripts 沒變,沿用核准(1.50.0 行為)。
    expect((await row(PLAIN))?.approval).toBe(await approval());
  });
});

describe("the install preview", () => {
  const get = (id: string) =>
    preview(new Request(`https://cms.test/api/registry/manifest?source=${encodeURIComponent(SOURCE)}&id=${id}`));

  it("has no script review for a compiled plugin", async () => {
    const compiled = (await (await get(COMPILED)).json()) as { scripts: unknown };
    expect(compiled.scripts).toBeNull();
    const plain = (await (await get(PLAIN)).json()) as { scripts: unknown };
    expect(plain.scripts).toEqual({ hash: await hashScripts(SCRIPTS), allowed: false, approved: false });
  });
});

describe("installed plugins", () => {
  it("cannot approve scripts that are compiled into the site", async () => {
    registryState.allowScripts = true;
    await insertInstalled(COMPILED, null);
    await insertInstalled(PLAIN, null);
    const refused = await approve(COMPILED);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "scripts_compiled" });
    expect((await row(COMPILED))?.approval).toBeNull();
    expect((await approve(PLAIN)).status).toBe(200);
  });

  it("reports compiled, running, stopped, or no scripts", async () => {
    const m = parseManifest(manifest(PLAIN)).manifest;
    expect(await installedScriptsState(COMPILED, parseManifest(manifest(COMPILED)).manifest, await approval())).toBe("compiled");
    expect(await installedScriptsState(PLAIN, m, await approval())).toBe("running");
    expect(await installedScriptsState(PLAIN, m, null)).toBe("stopped");
    expect(await installedScriptsState(PLAIN, parseManifest(manifest(PLAIN, { scripts: undefined })).manifest, null)).toBeNull();
  });
});

describe("CSP hosts of replaced scripts", () => {
  it("a compiled install adds no hosts", async () => {
    registryState.allowScripts = true;
    expect((await post({ id: COMPILED, source: SOURCE })).status).toBe(200);
    expect(await approvedScriptHosts(d1())).toEqual([]);
  });

  it("an approval from before the compile-in is retired once, and only for the compiled plugin", async () => {
    await insertInstalled(COMPILED, await approval(), 5);
    await insertInstalled(PLAIN, await approval(), 5);
    expect(await approvedScriptHosts(d1())).toEqual(["cdn.proof.test", "api.proof.test"]);

    const rows = [
      { id: COMPILED, scriptsApproval: await approval(), updatedAt: 5 },
      { id: PLAIN, scriptsApproval: await approval(), updatedAt: 5 },
    ];
    expect(await retireReplacedScriptApprovals(rows, 100)).toBe(true);
    // updated_at 推進:loader 與 CSP 的版本戳都會換。
    expect(await row(COMPILED)).toEqual({ approval: null, updatedAt: 100 });
    expect((await row(PLAIN))?.approval).toBe(await approval());
    // plain 的核准還在(主機跟 proof 一樣);拿掉它之後白名單是空的 —— proof 不再貢獻主機。
    await d1().prepare("DELETE FROM declarative_extensions WHERE id = ?").bind(PLAIN).run();
    expect(await approvedScriptHosts(d1())).toEqual([]);

    expect(
      await retireReplacedScriptApprovals([{ id: COMPILED, scriptsApproval: null, updatedAt: 100 }], 200),
    ).toBe(false);
  });

  it("gives way to an install that got there first", async () => {
    await insertInstalled(COMPILED, await approval(), 5);
    // 同一個 revision 已經被別人 claim 走(同時進行的安裝):不丟例外、不寫。
    await d1()
      .prepare("INSERT INTO ext_migrations (id, ext_id, applied_at) VALUES (?, ?, 1)")
      .bind(`${COMPILED}:install:5`, COMPILED)
      .run();
    await expect(
      retireReplacedScriptApprovals([{ id: COMPILED, scriptsApproval: await approval(), updatedAt: 5 }], 100),
    ).resolves.toBe(true);
    expect((await row(COMPILED))?.updatedAt).toBe(5);
  });
});
