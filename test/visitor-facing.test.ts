import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 2.0 頁面快取的記號 visitorFacing(src/lib/visitor-facing.ts):「訪客看得到依賴它的輸出」。
// 一條規則:寫到帶著記號的東西,存起來的公開頁全部重算。這個檔案逐項走過每一種會、不會讓頁面
// 重算的寫入,經過真正的寫入底層(content provider、setSettings、deleteFile、commerce-kit、插件管理
// 用的 wrote),結果要跟改成記號之前一樣;唯一刻意的改變是:設定存檔只改到沒記號的欄位不重算。
// 插件的宣告走 loader 用的同一個函式(declareExtensionsVisitorFacing)。
//
// 不在這裡的寫入(明確呼叫 publicContentChanged,escape hatch):改使用者名字(users-api.test.ts)、
// 首次設定的「已經有人」(setup-route.test.ts)、後台的「重算所有頁面」按鈕(public-pages-refresh.test.tsx)、
// 運費設定(services.publicContentChanged,沒宣告的 key)、插件用 services.db 直接寫。

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => ({ delete: async () => {} }),
}));

vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

const changed = vi.hoisted(() => ({ reasons: [] as string[] }));
vi.mock("@/lib/public-cache", () => ({
  publicContentChanged: (reason: string) => {
    changed.reasons.push(reason);
  },
}));

// 測試用的插件。loader 每次建 runtime 時用同一個函式登記它們的記號。
const EXTS = vi.hoisted(() => [
  {
    id: "acme",
    settings: [
      { key: "banner", label: "Banner", type: "text", default: "" },
      { key: "token", label: "Token", type: "text", default: "", visitorFacing: false },
    ],
    visitorFacingTables: ["ext_acme_stock"],
    visitorFacingFiles: true,
    contentTypes: [
      { name: "item", fields: [] },
      { name: "log", fields: [], visitorFacing: false },
    ],
  },
  { id: "quiet", visitorFacing: false },
  { id: "seller", visitorFacingTables: { ext_seller_orders: false } },
]);

vi.mock("@/ext/loader", async () => {
  const { HookBus } = await import("../src/ext/hooks");
  const { declareExtensionsVisitorFacing } = await import("../src/lib/visitor-facing");
  // 同 settings.ts 的 extSetting(在這裡 import settings.ts 會讓 workers pool 載入順序出錯)。
  const extSetting = (extId: string, key: string) => `ext.${extId}.${key}`;
  const rt = {
    enabled: EXTS as unknown[],
    all: EXTS as unknown[],
    hooks: new HookBus(),
    byId: () => undefined,
    isCompatible: () => true,
    unavailableById: new Map(),
  };
  return {
    getExtRuntime: async () => {
      declareExtensionsVisitorFacing(EXTS as never, EXTS as never, extSetting);
      return rt;
    },
  };
});

import { getExtRuntime } from "@/ext/loader";
import { CoreContentProvider, contentWritten } from "../src/ext/dx/content-provider";
import { HookBus } from "../src/ext/hooks";
import { setSettings, invalidateSettingsCache } from "../src/lib/settings";
import { deleteFile } from "../src/lib/storage";
import { kitTableWritten } from "../src/ext/commerce-kit/visitor-facing";
import { declareVisitorFacing, isVisitorFacing, wrote } from "../src/lib/visitor-facing";

const d1 = () => (env as { DB: D1Database }).DB;
const TYPE = "vf.post";

async function provider(): Promise<CoreContentProvider> {
  const p = new CoreContentProvider(new HookBus());
  await p.ensureType({
    type: TYPE,
    slugField: "title",
    fields: [
      { key: "title", type: "text", required: true },
      { key: "slug", type: "slug" },
    ],
  });
  return p;
}

async function draft(): Promise<{ p: CoreContentProvider; id: string }> {
  const p = await provider();
  const { id } = await p.create(TYPE, { title: "draft" });
  return { p, id };
}

async function published(): Promise<{ p: CoreContentProvider; id: string }> {
  const p = await provider();
  const { id } = await p.create(TYPE, { title: "live", status: "published" });
  return { p, id };
}

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT NOT NULL DEFAULT 'draft', publish_at INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(content_id UNINDEXED, type_key UNINDEXED, locale UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');",
  );
  await d1().exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);");
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS content_revisions (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, slug TEXT, status TEXT NOT NULL, publish_at INTEGER, data TEXT NOT NULL, actor_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM contents;");
  await d1().exec("DELETE FROM content_fts;");
  await d1().exec("DELETE FROM settings;");
  invalidateSettingsCache();
  await getExtRuntime();
});

interface Row {
  write: string;
  /** 準備(不算在結果裡)。回傳的東西交給 act。 */
  setup?: () => Promise<{ p: CoreContentProvider; id: string }>;
  act: (ctx: { p: CoreContentProvider; id: string }) => Promise<unknown> | unknown;
  refreshes: boolean;
}

const none = async () => ({ p: await provider(), id: "" });

const INVENTORY: Row[] = [
  // ---- content(預設 true;只算寫入前後任一邊已發佈的項目)----
  { write: "content: create a draft", setup: none, act: ({ p }) => p.create(TYPE, { title: "d" }), refreshes: false },
  { write: "content: edit a draft", setup: draft, act: ({ p, id }) => p.update(TYPE, id, { title: "d2" }), refreshes: false },
  { write: "content: schedule a draft", setup: draft, act: ({ p, id }) => p.update(TYPE, id, { publishAt: Date.now() + 60_000 }), refreshes: false },
  { write: "content: delete a draft", setup: draft, act: ({ p, id }) => p.delete(TYPE, id), refreshes: false },
  { write: "content: anonymous form submission (stored as a draft)", setup: none, act: ({ p }) => p.create(TYPE, { title: "spam" }), refreshes: false },
  { write: "content: create published", setup: none, act: ({ p }) => p.create(TYPE, { title: "p", status: "published" }), refreshes: true },
  { write: "content: publish a draft", setup: draft, act: ({ p, id }) => p.update(TYPE, id, { status: "published" }), refreshes: true },
  { write: "content: edit a published item", setup: published, act: ({ p, id }) => p.update(TYPE, id, { title: "p2" }), refreshes: true },
  { write: "content: unpublish", setup: published, act: ({ p, id }) => p.update(TYPE, id, { status: "draft" }), refreshes: true },
  { write: "content: delete a published item", setup: published, act: ({ p, id }) => p.delete(TYPE, id), refreshes: true },
  { write: "content: restore a published revision onto a draft", act: () => contentWritten(TYPE, "draft", "published"), refreshes: true },
  { write: "content: restore a draft revision onto a draft", act: () => contentWritten(TYPE, "draft", "draft"), refreshes: false },
  { write: "content: scheduled publish (publish-due)", act: () => wrote("content", TYPE, { before: false, after: true }), refreshes: true },
  { write: "content: a type marked visitorFacing:false, published edit", act: () => contentWritten("acme.log", "published", "published"), refreshes: false },
  { write: "content: a declared type left unmarked, published edit", act: () => contentWritten("acme.item", "published", "published"), refreshes: true },

  // ---- settings(宣告過的欄位預設 true;沒宣告的 key 預設 false)----
  { write: "settings: site title", act: () => setSettings({ "core.siteTitle": "T" }), refreshes: true },
  { write: "settings: site notice text", act: () => setSettings({ "core.notice.text": "Hi" }), refreshes: true },
  { write: "settings: email provider (login page offers password reset)", act: () => setSettings({ "core.provider.email:send": "core" }), refreshes: true },
  { write: "settings: page save mixing a marked and an unmarked key", act: () => setSettings({ "core.adminTheme": "x", "core.siteTitle": "T" }), refreshes: true },
  { write: "settings: admin theme save (POST /api/admin-theme)", act: () => setSettings({ "core.adminTheme": "x", "core.adminAccent": "#112233" }), refreshes: false },
  { write: "settings: page save of only unmarked keys (INTENDED CHANGE: refreshed before)", act: () => setSettings({ "core.notifyEmail": "a@b.c", "core.registrySources": "[]" }), refreshes: false },
  { write: "settings: licence check-in bookkeeping (undeclared key)", act: () => setSettings({ "core.license.lastCheckin": 1 }), refreshes: false },
  { write: "settings: demo callback marker (undeclared key)", act: () => setSettings({ "core.demoCallbackLastEvent": "{}" }), refreshes: false },
  { write: "settings: plugin field, declared and unmarked", act: () => setSettings({ "ext.acme.banner": "sale" }), refreshes: true },
  { write: "settings: plugin field marked visitorFacing:false", act: () => setSettings({ "ext.acme.token": "t" }), refreshes: false },
  { write: "settings: plugin key it never declared (services.settings.set bookkeeping)", act: () => setSettings({ "ext.acme.cursor": 5 }), refreshes: false },

  // ---- files(core 的媒體庫 true;avatars 與插件的檔案區預設 false)----
  { write: "files: admin media delete of a core file", act: () => deleteFile("core/2026/11/a.png"), refreshes: true },
  { write: "files: avatar replacement deletes the old avatar", act: () => deleteFile("avatars/2026/11/a.png"), refreshes: false },
  { write: "files: plugin deletes its own file", act: () => deleteFile("seller/2026/11/a.png"), refreshes: false },
  { write: "files: plugin with visitorFacingFiles:true deletes its file", act: () => deleteFile("acme/2026/11/a.png"), refreshes: true },

  // ---- tables(預設 false;commerce-kit 定義的表預設 true)----
  { write: "tables: write to a declared table (ledger-kit)", act: () => wrote("table", ["ext_acme_stock_ledger", "ext_acme_stock"]), refreshes: true },
  { write: "tables: write to an undeclared table (ledger-kit)", act: () => wrote("table", ["ext_other_accounts"]), refreshes: false },
  { write: "tables: commerce-kit order transition / promo save", act: () => kitTableWritten("ext_kit_orders"), refreshes: true },
  { write: "tables: commerce-kit table the plugin opted out of", act: () => kitTableWritten("ext_seller_orders"), refreshes: false },

  // ---- extension(插件本身:安裝、重裝、啟用、停用、移除、script 核准;預設 true)----
  { write: "extension: lifecycle or script approval of an unmarked plugin", act: () => wrote("extension", "acme"), refreshes: true },
  { write: "extension: install of a plugin nobody has declared yet", act: () => wrote("extension", "brand-new"), refreshes: true },
  { write: "extension: lifecycle of a plugin marked visitorFacing:false", act: () => wrote("extension", "quiet"), refreshes: false },
];

describe("visitorFacing inventory: every write refreshes exactly as before", () => {
  it.each(INVENTORY)("$write → refreshes: $refreshes", async (row) => {
    const ctx = row.setup ? await row.setup() : { p: undefined as never, id: "" };
    changed.reasons = [];
    await row.act(ctx);
    expect(changed.reasons.length > 0).toBe(row.refreshes);
    expect(changed.reasons.length).toBeLessThanOrEqual(1);
  });
});

describe("the marker per kind", () => {
  it("defaults: things people edit are true, things programs write are false", () => {
    expect(isVisitorFacing("content", "nobody.declared")).toBe(true);
    expect(isVisitorFacing("extension", "nobody-declared")).toBe(true);
    expect(isVisitorFacing("setting", "ext.nobody.key")).toBe(false);
    expect(isVisitorFacing("table", "ext_nobody")).toBe(false);
    expect(isVisitorFacing("files", "nobody")).toBe(false);
  });

  it("opt in and opt out for each kind", () => {
    declareVisitorFacing("test", "content", [["t.in", true], ["t.out", false]]);
    declareVisitorFacing("test", "setting", [["ext.t.in", true], ["ext.t.out", false]]);
    declareVisitorFacing("test", "table", [["ext_t_in", true], ["ext_t_out", false]]);
    declareVisitorFacing("test", "files", [["t-in", true], ["t-out", false]]);
    declareVisitorFacing("test", "extension", [["t-in", true], ["t-out", false]]);
    for (const [kind, yes, no] of [
      ["content", "t.in", "t.out"],
      ["setting", "ext.t.in", "ext.t.out"],
      ["table", "ext_t_in", "ext_t_out"],
      ["files", "t-in", "t-out"],
      ["extension", "t-in", "t-out"],
    ] as const) {
      expect(isVisitorFacing(kind, yes)).toBe(true);
      expect(isVisitorFacing(kind, no)).toBe(false);
    }
    declareVisitorFacing("test", "content", []);
    expect(isVisitorFacing("content", "t.out")).toBe(true);
  });

  it("a definer's default loses to the using plugin's declaration, either way", () => {
    declareVisitorFacing("kit", "table", [["ext_t_kit", true]], { fallback: true });
    expect(isVisitorFacing("table", "ext_t_kit")).toBe(true);
    declareVisitorFacing("user", "table", [["ext_t_kit", false]]);
    expect(isVisitorFacing("table", "ext_t_kit")).toBe(false);
    declareVisitorFacing("user", "table", []);
  });

  it("code-defined content types carry their marker through ensureType", async () => {
    const p = new CoreContentProvider(new HookBus());
    await p.ensureType({ type: "vf.private", visitorFacing: false, fields: [{ key: "title", type: "text" }] });
    expect(isVisitorFacing("content", "vf.private")).toBe(false);
  });

  it("the reason names the kind and what was written", () => {
    changed.reasons = [];
    wrote("table", ["ext_acme_stock", "ext_acme_stock", "ext_other"]);
    expect(changed.reasons).toEqual(["table:ext_acme_stock"]);
  });
});
