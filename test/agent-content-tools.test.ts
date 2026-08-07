import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// docs/spec-admin-agent.md Phase A:declarative contentTypes → agent tools 的自動生成。
// 三件事要守住:(1) 生出來的 tool 名字/kind 正確,(2) 收件匣型別不長出 create/update,
// (3) 從 manifest fields 衍生的 args schema 真的擋得住壞資料、也真的收得下好資料。
vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));

// @/ext/loader 全 mock:provider 的 create 會經 getDefaultContentLocale → getSetting
// → secretKeySetAsync,而它 dynamic import loader(真實 loader 在 workers pool 載不起來)。
vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const rt = {
    enabled: [] as unknown[],
    all: [] as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return { getExtRuntime: async () => rt };
});

import { invokeAgentTool } from "../src/ext/agent-tools";
import type { AgentTool, AgentToolCtx } from "../src/ext/agent-tools";
import {
  contentToolSlug,
  contentTypeAgentTools,
  listDeclarativeAgentTools,
  manifestAgentTools,
} from "../src/ext/dx/agent-tools";
import { describeFields } from "../src/ext/dx/agent-field-schema";
import { buildAgentToolRegistry } from "../src/ext/agent-tools-runtime";
import { parseManifest } from "../src/ext/dx/manifest";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";
import { CoreContentProvider } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { invalidateSettingsCache } from "../src/lib/settings";

type TestEnv = { DB: D1Database };
const d1 = () => (env as TestEnv).DB;

const CONTENTS_DDL =
  "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);";

beforeAll(async () => {
  await d1().exec(CONTENTS_DDL);
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);",
  );
  // provider 的 create/update 會留版本快照(best-effort,缺表只是 log)。建起來讓
  // 端到端測試走的是完整寫入路徑,而不是一條吞掉一半的降級路徑。
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  await d1().exec("DELETE FROM declarative_extensions;");
  await d1().exec("DELETE FROM content_revisions;");
  invalidateSettingsCache();
});

function makeCtx(): AgentToolCtx {
  const provider = new CoreContentProvider(new HookBus());
  return {
    user: { id: "u1", email: "a@test.com", name: "A", role: "admin", avatarKey: null },
    services: { providers: { get: () => provider } },
  } as unknown as AgentToolCtx;
}

const ITEM: DeclarativeContentType = {
  name: "item",
  label: "Gallery item",
  slugField: "title",
  fields: [
    { key: "title", type: "text", required: true },
    { key: "shotAt", type: "date" },
    { key: "tag", type: "select", options: ["street", "studio"] },
    { key: "body", type: "richtext" },
    { key: "related", type: "relations", to: "gallery.item" },
    { key: "meta", type: "group", fields: [{ key: "camera", type: "text", required: true }] },
    { key: "rows", type: "repeater", fields: [{ key: "caption", type: "text" }] },
    {
      key: "layout",
      type: "blocks",
      blocks: [
        { name: "hero", fields: [{ key: "heading", type: "text", required: true }] },
        { name: "quote", fields: [{ key: "text", type: "text" }] },
      ],
    },
  ],
};

function byName(tools: readonly AgentTool[]): Map<string, AgentTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

/** 造一份會通過 parseManifest 的 manifest(fixture 不會偷偷偏離真實 schema)。 */
function manifestOf(
  contentTypes: unknown[],
  publicRoutes?: unknown[],
): ReturnType<typeof parseManifest>["manifest"] {
  const parsed = parseManifest({
    kind: "declarative",
    id: "gallery",
    name: "Gallery",
    version: "1.0.0",
    coreApi: "^1.28.0",
    contentTypes,
    ...(publicRoutes ? { publicRoutes } : {}),
  });
  if (!parsed.ok || !parsed.manifest) throw new Error(`bad fixture: ${parsed.error}`);
  return parsed.manifest;
}

const SIMPLE_TYPE = { name: "item", fields: [{ key: "title", type: "text" }] };

// ------------------------------------------------------------- 生成的形狀

describe("contentTypeAgentTools(spec §2:每個 content type 自動長出 CRUD tools)", () => {
  it("一般內容型別:list/get 為 read,create/update/delete 為 write", () => {
    const tools = contentTypeAgentTools("gallery", ITEM);
    expect(tools.map((t) => `${t.name} ${t.kind}`).sort()).toEqual([
      "content.gallery_item.create write",
      "content.gallery_item.delete write",
      "content.gallery_item.get read",
      "content.gallery_item.list read",
      "content.gallery_item.update write",
    ]);
  });

  it("type key 的 `.` 壓成 `_`(spec §2 的 content.gallery_item.list 例子)", () => {
    expect(contentToolSlug("gallery", "item")).toBe("gallery_item");
  });

  it("description 帶著欄位清單 —— Phase B 之前那是模型認識欄位的唯一管道", () => {
    const tools = byName(contentTypeAgentTools("gallery", ITEM));
    const create = tools.get("content.gallery_item.create")!;
    expect(create.description).toContain("title (text, required)");
    expect(create.description).toContain("tag (select: street|studio)");
    expect(create.description).toContain("related (relations → gallery.item)");
  });

  it("describeFields 把結構欄位的子欄位也講出來", () => {
    expect(describeFields(ITEM.fields)).toContain("meta (group{camera})");
    expect(describeFields(ITEM.fields)).toContain("layout (blocks{hero|quote})");
  });
});

// ------------------------------------------------------------ submission 收窄

describe("submission 收窄(訊息不可變,且站方不偽造來信)", () => {
  it("收件匣型別只長出 list/get/delete", () => {
    const tools = contentTypeAgentTools("contact", ITEM, true);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "content.contact_item.delete",
      "content.contact_item.get",
      "content.contact_item.list",
    ]);
  });

  it('明寫 kind:"submission" → manifestAgentTools 一路收窄', () => {
    const m = manifestOf([{ ...SIMPLE_TYPE, kind: "submission" }]);
    expect(manifestAgentTools(m!).map((t) => t.name).sort()).toEqual([
      "content.gallery_item.delete",
      "content.gallery_item.get",
      "content.gallery_item.list",
    ]);
  });

  it("向後相容推論:public:true 且無任何 list/detail public route → 收窄", () => {
    const m = manifestOf(
      [{ ...SIMPLE_TYPE, public: true }],
      [{ pattern: "/contact", view: "form", contentType: "item" }],
    );
    expect(manifestAgentTools(m!).some((t) => t.kind === "write" && t.name.endsWith(".create"))).toBe(
      false,
    );
  });

  it("public:true 但有公開 list route(UGC 留言板)→ 不收窄,CRUD 齊全", () => {
    const m = manifestOf(
      [{ ...SIMPLE_TYPE, public: true }],
      [{ pattern: "/wall", view: "list", contentType: "item" }],
    );
    expect(manifestAgentTools(m!).map((t) => t.name).sort()).toEqual([
      "content.gallery_item.create",
      "content.gallery_item.delete",
      "content.gallery_item.get",
      "content.gallery_item.list",
      "content.gallery_item.update",
    ]);
  });

  it('明寫 kind:"content" 關掉推論(public:true 也照樣長出 create/update)', () => {
    const m = manifestOf([{ ...SIMPLE_TYPE, public: true, kind: "content" }]);
    expect(manifestAgentTools(m!).map((t) => t.name)).toContain(
      "content.gallery_item.create",
    );
  });
});

// -------------------------------------------------------- 從 fields 衍生的 schema

describe("args schema 從 manifest fields 衍生", () => {
  const tools = byName(contentTypeAgentTools("gallery", ITEM));
  const create = tools.get("content.gallery_item.create")!;
  const update = tools.get("content.gallery_item.update")!;
  const list = tools.get("content.gallery_item.list")!;

  const parse = (tool: AgentTool, args: unknown) => tool.schema.safeParse(args);

  it("create:必填欄位缺了就退回", () => {
    expect(parse(create, { data: { shotAt: 1 } }).success).toBe(false);
    expect(parse(create, { data: { title: "T" } }).success).toBe(true);
  });

  it("update:全部 optional(只改一個欄位是合法的,provider 端本來就是淺層合併)", () => {
    expect(parse(update, { id: "x", data: {} }).success).toBe(true);
    expect(parse(update, { id: "x", data: { shotAt: 1 } }).success).toBe(true);
    expect(parse(update, { data: { title: "T" } }).success).toBe(false); // 缺 id
  });

  it("未宣告的欄位一律退回(不讓幻覺出來的欄位安靜落地)", () => {
    const bad = parse(create, { data: { title: "T", nonsense: 1 } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("nonsense");
  });

  it("select 只收宣告過的選項", () => {
    expect(parse(create, { data: { title: "T", tag: "studio" } }).success).toBe(true);
    expect(parse(create, { data: { title: "T", tag: "kitchen" } }).success).toBe(false);
  });

  it("date 收 epoch 數字與可解析字串(不比 provider 嚴)", () => {
    expect(parse(create, { data: { title: "T", shotAt: 1_700_000_000_000 } }).success).toBe(true);
    expect(parse(create, { data: { title: "T", shotAt: "2026-08-07" } }).success).toBe(true);
    expect(parse(create, { data: { title: "T", shotAt: true } }).success).toBe(false);
  });

  it("richtext 收 Tiptap 文件物件,也收 provider 仍相容的純字串", () => {
    expect(parse(create, { data: { title: "T", body: "plain" } }).success).toBe(true);
    expect(
      parse(create, { data: { title: "T", body: { type: "doc", content: [] } } }).success,
    ).toBe(true);
    expect(parse(create, { data: { title: "T", body: 42 } }).success).toBe(false);
  });

  it("relations 收字串陣列;空字串元素退回", () => {
    expect(parse(create, { data: { title: "T", related: ["a", "b"] } }).success).toBe(true);
    expect(parse(create, { data: { title: "T", related: [""] } }).success).toBe(false);
    expect(parse(create, { data: { title: "T", related: "a" } }).success).toBe(false);
  });

  it("group/repeater 的子欄位必填照宣告執行(巢狀是整包替換語意)", () => {
    expect(parse(create, { data: { title: "T", meta: { camera: "X100" } } }).success).toBe(true);
    expect(parse(create, { data: { title: "T", meta: {} } }).success).toBe(false);
    expect(
      parse(create, { data: { title: "T", rows: [{ caption: "a" }, {}] } }).success,
    ).toBe(true);
  });

  it("blocks 是具名 union:block 名稱不對、或該 block 的必填缺了都退回", () => {
    expect(
      parse(create, { data: { title: "T", layout: [{ block: "hero", heading: "H" }] } }).success,
    ).toBe(true);
    expect(
      parse(create, { data: { title: "T", layout: [{ block: "hero" }] } }).success,
    ).toBe(false);
    expect(
      parse(create, { data: { title: "T", layout: [{ block: "banner" }] } }).success,
    ).toBe(false);
  });

  it("list 的 sort 限成「已宣告欄位 + 兩個 row 時戳」", () => {
    expect(parse(list, { sort: "title" }).success).toBe(true);
    expect(parse(list, { sort: "updatedAt", dir: "asc" }).success).toBe(true);
    expect(parse(list, { sort: "whatever" }).success).toBe(false);
    expect(parse(list, { perPage: 500 }).success).toBe(false);
  });
});

// ------------------------------------------------------------- 端到端(D1)

describe("生成的 tools 端到端跑在真的 D1 上", () => {
  const tools = byName(contentTypeAgentTools("blog", {
    name: "post",
    label: "Post",
    slugField: "title",
    fields: [
      { key: "title", type: "text", required: true },
      { key: "views", type: "number" },
    ],
  }));

  it("create → get → list → update → delete 全程可用", async () => {
    const ctx = makeCtx();

    const created = await invokeAgentTool(tools.get("content.blog_post.create")!, ctx, {
      data: { title: "Concentric radii", views: 1 },
      status: "published",
    });
    expect(created.ok).toBe(true);
    const id = created.ok === true ? (created.result as { id: string }).id : "";
    expect(id).toBeTruthy();

    const got = await invokeAgentTool(tools.get("content.blog_post.get")!, ctx, { id });
    expect(got.ok === true && (got.result as { data: unknown; slug: string }).slug).toBe(
      "concentric-radii",
    );

    // list 回摘要(含推導出來的 title),刻意不帶整份 data。
    const listed = await invokeAgentTool(tools.get("content.blog_post.list")!, ctx, {});
    expect(listed.ok).toBe(true);
    const page = listed.ok === true ? (listed.result as { items: Record<string, unknown>[]; total: number }) : { items: [], total: 0 };
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id, title: "Concentric radii", status: "published" });
    expect(Object.hasOwn(page.items[0], "data")).toBe(false);

    const updated = await invokeAgentTool(tools.get("content.blog_post.update")!, ctx, {
      id,
      data: { views: 99 },
    });
    // 只送了 views,title 由 provider 的淺層合併保留下來。
    expect(updated.ok === true && (updated.result as { data: Record<string, unknown> }).data).toMatchObject({
      title: "Concentric radii",
      views: 99,
    });

    const removed = await invokeAgentTool(tools.get("content.blog_post.delete")!, ctx, { id });
    expect(removed).toEqual({ ok: true, result: { deleted: id } });

    const after = await invokeAgentTool(tools.get("content.blog_post.get")!, ctx, { id });
    expect(after).toEqual({ ok: true, result: null });
  });

  it("已知既有行為:status 同時設定 row 狀態,也會被留在 JSON data 裡", async () => {
    // ContentProvider 沒有「只設 row 狀態」的入口 —— status 必須放在 payload 裡送,
    // 而 validateData 依 core-v2 §2.4 保留未宣告的 top-level key。CRUD route(POST/PUT
    // 直接把整個 body 交給 provider)長久以來就是這個行為,不是本次生成器新增的。
    // 這裡明寫成斷言,是為了讓它是「已知的」而不是「沒人看見的」。
    const created = await invokeAgentTool(tools.get("content.blog_post.create")!, makeCtx(), {
      data: { title: "T" },
      status: "published",
    });
    expect(created.ok === true && (created.result as { status: string }).status).toBe(
      "published",
    );
    expect(created.ok === true && (created.result as { data: Record<string, unknown> }).data)
      .toHaveProperty("status", "published");
  });

  it("delete 不存在的 id 明確失敗,不會回報成「已刪除」", async () => {
    const res = await invokeAgentTool(tools.get("content.blog_post.delete")!, makeCtx(), {
      id: "ghost",
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toContain("not_found");
  });

  it("provider 的欄位驗證仍是最終權威(schema 放行、語意不合照樣擋)", async () => {
    // media key 形狀由 provider 的 isMediaKey 把關,衍生 schema 只知道它是字串。
    const withMedia = byName(
      contentTypeAgentTools("blog", {
        name: "shot",
        fields: [{ key: "image", type: "media", required: true }],
      }),
    );
    const res = await invokeAgentTool(withMedia.get("content.blog_shot.create")!, makeCtx(), {
      data: { image: "../../etc/passwd" },
    });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------- 從 DB 列組出所有 tools

describe("listDeclarativeAgentTools", () => {
  async function seed(id: string, manifest: unknown, enabled = 1): Promise<void> {
    await d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?,?,?,?)",
      )
      .bind(id, "1.0.0", JSON.stringify(manifest), enabled)
      .run();
  }

  it("只吃 enabled 的列,壞掉的列跳過而不是讓整份清單掛掉", async () => {
    await seed("gallery", {
      kind: "declarative",
      id: "gallery",
      name: "Gallery",
      version: "1.0.0",
      coreApi: "^1.28.0",
      contentTypes: [SIMPLE_TYPE],
    });
    await seed("disabled", {
      kind: "declarative",
      id: "disabled",
      name: "Off",
      version: "1.0.0",
      coreApi: "^1.28.0",
      contentTypes: [SIMPLE_TYPE],
    }, 0);
    // 非 JSON 的列。
    await d1()
      .prepare(
        "INSERT INTO declarative_extensions (id, version, manifest, enabled) VALUES (?,?,?,?)",
      )
      .bind("broken", "1.0.0", "{not json", 1)
      .run();

    const names = (await listDeclarativeAgentTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      "content.gallery_item.create",
      "content.gallery_item.delete",
      "content.gallery_item.get",
      "content.gallery_item.list",
      "content.gallery_item.update",
    ]);
  });

  it("buildAgentToolRegistry 把 core 與生成的 tools 收進同一個 registry", async () => {
    await seed("gallery", {
      kind: "declarative",
      id: "gallery",
      name: "Gallery",
      version: "1.0.0",
      coreApi: "^1.28.0",
      contentTypes: [SIMPLE_TYPE],
    });

    const registry = await buildAgentToolRegistry();
    const names = registry.names();
    // core 前綴與 content 前綴共存,且沒有任何撞名(register 會 throw,走到這裡就代表沒撞)。
    expect(names).toContain("core.settings.get");
    expect(names).toContain("content.gallery_item.list");
    expect(new Set(names).size).toBe(names.length);
    // kind 標注一路帶到 registry —— Phase C 的 loop 只會取 read 那一半。
    expect(registry.list("write").map((t) => t.name).sort()).toEqual([
      "content.gallery_item.create",
      "content.gallery_item.delete",
      "content.gallery_item.update",
    ]);
  });
});
