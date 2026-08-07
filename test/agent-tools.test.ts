import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { z } from "zod";

// docs/spec-admin-agent.md Phase A:tool registry 契約 + core 內建 read tools。
// binding-backed(miniflare D1),同既有慣例 mock @/lib/cf 讓 db()/getDB() 打到 env.DB。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock(同 notify.test.ts / settings-cache.test.ts):真實 loader 經
// interpret.tsx → DetailView 拉進 next/navigation,workers pool 靜態解析會炸。這裡的
// mock 同時是測試裝置 —— core.extensions.list 與 settings 的 secret 判定都讀 rt.enabled,
// 由下面的 runtimeState 逐案控制。
const runtimeState = vi.hoisted(() => ({
  enabled: [] as unknown[],
  all: [] as unknown[],
  unavailable: new Map<string, unknown>(),
}));
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  return {
    getExtRuntime: async () => ({
      enabled: runtimeState.enabled,
      all: runtimeState.all,
      hooks: new HookBus(),
      byId: () => undefined,
      isCompatible: () => true,
      unavailableById: runtimeState.unavailable,
    }),
  };
});

import {
  AgentToolRegistryImpl,
  defineAgentTool,
  invokeAgentTool,
} from "../src/ext/agent-tools";
import type { AgentTool, AgentToolCtx } from "../src/ext/agent-tools";
import {
  coreAgentTools,
  describeExtensions,
  readSettingsSafely,
} from "../src/ext/agent-tools-core";
import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { indexContentEntry } from "../src/lib/search";
import { invalidateSettingsCache, setSettings } from "../src/lib/settings";
import type { SettingField } from "../src/lib/settings";
import type { Extension } from "../src/ext/types";
import type { ExtRuntime } from "../src/ext/loader";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";
const SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(SETTINGS_DDL);
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  // 直接清表繞開寫入路徑,需一併清 isolate settings 快取(同 notify.test.ts)。
  invalidateSettingsCache();
  runtimeState.enabled = [];
  runtimeState.all = [];
  runtimeState.unavailable = new Map();
});

/** tool 只讀 ctx.services.providers.get();其餘欄位不需要真材實料。 */
function makeCtx(): AgentToolCtx {
  const provider = new CoreContentProvider(new HookBus());
  return {
    user: { id: "u1", email: "a@test.com", name: "A", role: "admin", avatarKey: null },
    services: { providers: { get: () => provider } },
  } as unknown as AgentToolCtx;
}

function noopTool(
  name: string,
  kind: "read" | "write" = "read",
): AgentTool {
  return defineAgentTool({
    name,
    description: `test tool ${name}`,
    kind,
    schema: z.object({}).strict(),
    run: async () => ({ ok: true }),
  });
}

// ---------------------------------------------------------------- registry

describe("AgentToolRegistry(spec §2:同 providers.ts 模式)", () => {
  it("註冊後可依 name 取回;未註冊回 null", () => {
    const reg = new AgentToolRegistryImpl();
    const tool = noopTool("core.demo.ping");
    reg.register(tool);
    expect(reg.get("core.demo.ping")).toBe(tool);
    expect(reg.get("core.demo.nope")).toBeNull();
  });

  it("重複 name 一律 throw(不是後蓋前、也不是靜默忽略)", () => {
    const reg = new AgentToolRegistryImpl();
    reg.register(noopTool("core.demo.ping"));
    expect(() => reg.register(noopTool("core.demo.ping"))).toThrow(/duplicate/);
    // 先註冊的那個仍在,沒有被半途覆寫。
    expect(reg.names()).toEqual(["core.demo.ping"]);
  });

  it("name 不合慣例 → 建立時就 throw(至少兩段點分小寫)", () => {
    for (const bad of ["nodots", "Core.Demo.Ping", "core..ping", "core.demo.", "-x.y"]) {
      expect(() => noopTool(bad), bad).toThrow(/invalid tool name/);
    }
    // 合法:content type key 的 `.` 壓成 `_` 之後仍是三段。
    expect(() => noopTool("content.gallery_item.list")).not.toThrow();
  });

  it("description 空白 → throw(對 LLM 而言那等於這個 tool 不存在)", () => {
    expect(() =>
      defineAgentTool({
        name: "core.demo.ping",
        description: "   ",
        kind: "read",
        schema: z.object({}).strict(),
        run: async () => null,
      }),
    ).toThrow(/empty description/);
  });

  it("手寫的 tool 物件(未走 defineAgentTool)在 register 時同樣受檢", () => {
    const reg = new AgentToolRegistryImpl();
    const raw: AgentTool = {
      name: "BAD NAME",
      description: "x",
      kind: "read",
      schema: z.object({}).strict(),
      execute: async () => null,
    };
    expect(() => reg.register(raw)).toThrow(/invalid tool name/);
  });

  it("list(kind) 依 kind 過濾,且輸出順序穩定(依 name 排序)", () => {
    const reg = new AgentToolRegistryImpl();
    reg.registerAll([
      noopTool("core.z.read"),
      noopTool("core.a.write", "write"),
      noopTool("core.a.read"),
    ]);
    expect(reg.names()).toEqual(["core.a.read", "core.a.write", "core.z.read"]);
    expect(reg.list("read").map((t) => t.name)).toEqual([
      "core.a.read",
      "core.z.read",
    ]);
    expect(reg.list("write").map((t) => t.name)).toEqual(["core.a.write"]);
  });
});

// ------------------------------------------------------------ invoke/schema

describe("invokeAgentTool(schema 驗證與錯誤收斂)", () => {
  const strictSchema = z
    .object({ id: z.string().min(1), count: z.number().int().optional() })
    .strict();

  function toolWithSpy(run: (args: { id: string }) => unknown) {
    const spy = vi.fn(async (_ctx: AgentToolCtx, args: { id: string }) =>
      run(args),
    );
    return {
      spy,
      tool: defineAgentTool({
        name: "core.demo.echo",
        description: "echo",
        kind: "read",
        schema: strictSchema,
        run: spy,
      }),
    };
  }

  it("壞 args 直接退回,且 run 完全不會被呼叫", async () => {
    const { tool, spy } = toolWithSpy((a) => a);
    const missing = await invokeAgentTool(tool, makeCtx(), {});
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ error: "invalid_args" });
    expect(spy).not.toHaveBeenCalled();

    const wrongType = await invokeAgentTool(tool, makeCtx(), { id: 1 });
    expect(wrongType.ok).toBe(false);

    // .strict():多帶欄位也退回(hallucinated 參數不會安靜地被吞掉)。
    const extra = await invokeAgentTool(tool, makeCtx(), { id: "x", bogus: 1 });
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.issues?.join(" ")).toMatch(/bogus/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("好 args → ok:true,run 收到已 parse 的值", async () => {
    const { tool, spy } = toolWithSpy((a) => ({ seen: a.id }));
    const res = await invokeAgentTool(tool, makeCtx(), { id: "abc" });
    expect(res).toEqual({ ok: true, result: { seen: "abc" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("execute 內部 throw → 收斂成 ok:false,錯誤摘要截斷", async () => {
    const long = "x".repeat(500);
    const tool = defineAgentTool({
      name: "core.demo.boom",
      description: "boom",
      kind: "read",
      schema: z.object({}).strict(),
      run: async () => {
        throw new Error(long);
      },
    });
    const res = await invokeAgentTool(tool, makeCtx(), {});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.length).toBe(201); // 200 + 省略號
  });

  it("tool.execute 自身也會驗 schema(不倚賴呼叫端先驗)", async () => {
    const { tool, spy } = toolWithSpy((a) => a);
    await expect(tool.execute(makeCtx(), { nope: true })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- core tools

describe("core 內建 tools(spec §2 表格第一列)", () => {
  it("四個 tool 齊備,而且全部是 read", () => {
    const tools = coreAgentTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "core.content.get",
      "core.content.search",
      "core.extensions.list",
      "core.settings.get",
    ]);
    expect(tools.every((t) => t.kind === "read")).toBe(true);
  });

  it("core.content.search 找得到內容,並回傳可餵給 get 的 id/typeKey", async () => {
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        "e1",
        "blog.post",
        "en",
        "e1",
        "hello",
        "published",
        JSON.stringify({ title: "Concentric radii", body: "paper and ink" }),
        1,
        1,
      )
      .run();
    await indexContentEntry("e1", "blog.post", "en", {
      title: "Concentric radii",
      body: "paper and ink",
    });

    const search = coreAgentTools().find((t) => t.name === "core.content.search")!;
    const res = await invokeAgentTool(search, makeCtx(), { q: "concentric" });
    expect(res.ok).toBe(true);
    const hits = res.ok === true ? (res.result as { id: string; typeKey: string }[]) : [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "e1", typeKey: "blog.post" });
  });

  it("core.content.search 拒絕過短 query(provider 端本來就會回空,先擋更誠實)", async () => {
    const search = coreAgentTools().find((t) => t.name === "core.content.search")!;
    const res = await invokeAgentTool(search, makeCtx(), { q: "a" });
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
  });

  it("core.content.get 依 type/id 讀回整筆;type key 形狀不對直接退回", async () => {
    await d1()
      .prepare(
        "INSERT INTO contents (id, type, locale, translation_group, slug, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind("e2", "blog.post", "en", "e2", "x", "draft", JSON.stringify({ title: "T" }), 1, 1)
      .run();

    const get = coreAgentTools().find((t) => t.name === "core.content.get")!;
    const ok = await invokeAgentTool(get, makeCtx(), { type: "blog.post", id: "e2" });
    expect(ok.ok === true && (ok.result as { data: unknown }).data).toEqual({ title: "T" });

    const missing = await invokeAgentTool(get, makeCtx(), { type: "blog.post", id: "nope" });
    expect(missing).toEqual({ ok: true, result: null });

    const bad = await invokeAgentTool(get, makeCtx(), { type: "notatypekey", id: "e2" });
    expect(bad).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

// ------------------------------------------------------- settings / secrets

describe("core.settings.get:secret 欄位過濾(spec §1.3)", () => {
  const fields = new Map<string, SettingField>([
    ["core.siteTitle", { key: "core.siteTitle", label: "Site Title", type: "text", default: "" }],
    ["core.apiSecret", { key: "core.apiSecret", label: "API Secret", type: "text", secret: true, default: "" }],
    ["ext.acme.token", { key: "ext.acme.token", label: "Acme token", type: "text", secret: true, default: "" }],
  ]);

  it("secret 的值連讀都不讀 —— 不是讀出來再遮罩", async () => {
    const read = vi.fn(async (key: string) => {
      if (key.includes("Secret") || key.endsWith("token")) {
        throw new Error(`secret key "${key}" must never be read`);
      }
      return "My Site";
    });

    const views = await readSettingsSafely(fields, read);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("core.siteTitle");
    expect(views).toEqual([
      { key: "core.apiSecret", label: "API Secret", type: "text", secret: true },
      { key: "core.siteTitle", label: "Site Title", type: "text", secret: false, value: "My Site" },
      { key: "ext.acme.token", label: "Acme token", type: "text", secret: true },
    ]);
    // secret 條目連 `value` 這個 key 都沒有(不是 value: null/"•••")。
    expect(Object.hasOwn(views[0], "value")).toBe(false);
  });

  it("keys 過濾只回傳指定的;未知 key 靜默略過", async () => {
    const views = await readSettingsSafely(
      fields,
      async () => "v",
      ["core.siteTitle", "core.nonexistent"],
    );
    expect(views.map((v) => v.key)).toEqual(["core.siteTitle"]);
  });

  it("端到端:extension 宣告的 secret 也擋得住,明文不出現在結果裡", async () => {
    // extension 自己宣告的 secret setting —— 判定來自 field 宣告,不是 core 白名單。
    runtimeState.enabled = [
      {
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        coreApi: "^1.0.0",
        settings: [
          { key: "token", label: "Acme token", type: "text", secret: true, default: "" },
          { key: "endpoint", label: "Acme endpoint", type: "text", default: "" },
        ],
      } satisfies Partial<Extension> as Extension,
    ];
    await setSettings({
      "core.siteTitle": "Suko",
      "core.apiSecret": "sk-core-do-not-leak",
      "ext.acme.token": "tok-do-not-leak",
      "ext.acme.endpoint": "https://acme.test",
    });

    const tool = coreAgentTools().find((t) => t.name === "core.settings.get")!;
    const res = await invokeAgentTool(tool, makeCtx(), {});
    expect(res.ok).toBe(true);
    const views = res.ok === true ? (res.result as { key: string; secret: boolean }[]) : [];

    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain("sk-core-do-not-leak");
    expect(serialized).not.toContain("tok-do-not-leak");

    const byKey = new Map(views.map((v) => [v.key, v]));
    expect(byKey.get("core.apiSecret")).toMatchObject({ secret: true });
    expect(Object.hasOwn(byKey.get("core.apiSecret")!, "value")).toBe(false);
    expect(byKey.get("ext.acme.token")).toMatchObject({ secret: true });
    expect(Object.hasOwn(byKey.get("ext.acme.token")!, "value")).toBe(false);
    // 非 secret 的照樣讀得到(否則這個 tool 就沒用了)。
    expect(byKey.get("core.siteTitle")).toMatchObject({ value: "Suko" });
    expect(byKey.get("ext.acme.endpoint")).toMatchObject({
      value: "https://acme.test",
    });
  });
});

// ------------------------------------------------------------- extensions

describe("core.extensions.list", () => {
  const codeExt = {
    id: "posts",
    name: "Posts",
    version: "1.2.0",
    coreApi: "^1.0.0",
    description: "Blog posts",
  } as Extension;
  const dxExt = {
    id: "gallery",
    name: { en: "Gallery", "zh-Hant": "作品集" },
    version: "1.0.0",
    coreApi: "^1.8.0",
    contentTypes: [{ name: "item", fields: [{ key: "title", type: "text" }] }],
  } as Extension;

  it("依 rt.all 分辨 code / declarative,並列出完整 content type key", () => {
    const listing = describeExtensions({
      enabled: [codeExt, dxExt],
      all: [codeExt],
      unavailableById: new Map(),
    } as unknown as Pick<ExtRuntime, "enabled" | "all" | "unavailableById">);

    expect(listing.enabled).toEqual([
      {
        id: "posts",
        name: "Posts",
        version: "1.2.0",
        coreApi: "^1.0.0",
        kind: "code",
        description: "Blog posts",
        contentTypes: [],
      },
      {
        id: "gallery",
        name: "Gallery",
        version: "1.0.0",
        coreApi: "^1.8.0",
        kind: "declarative",
        description: undefined,
        contentTypes: ["gallery.item"],
      },
    ]);
  });

  it("載不起來的 extension 也回報,附上原因(agent 最常要回答的問題)", () => {
    const listing = describeExtensions({
      enabled: [],
      all: [],
      unavailableById: new Map([
        ["shop", { kind: "core-api-incompatible", coreApi: "^2.0.0", coreVersion: "1.28.0" }],
        ["broken", { kind: "migration-failed" }],
      ]),
    } as unknown as Pick<ExtRuntime, "enabled" | "all" | "unavailableById">);

    expect(listing.unavailable).toEqual([
      { id: "shop", reason: "core-api-incompatible (needs ^2.0.0, core is 1.28.0)" },
      { id: "broken", reason: "migration-failed" },
    ]);
  });

  it("端到端:tool 走 runtime 拿到同一份清單", async () => {
    runtimeState.enabled = [dxExt];
    runtimeState.all = [];
    const tool = coreAgentTools().find((t) => t.name === "core.extensions.list")!;
    const res = await invokeAgentTool(tool, makeCtx(), {});
    expect(res.ok).toBe(true);
    expect(res.ok === true && (res.result as { enabled: { id: string }[] }).enabled).toEqual([
      expect.objectContaining({ id: "gallery", kind: "declarative" }),
    ]);
  });
});
