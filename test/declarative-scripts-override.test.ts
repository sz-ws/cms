import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.51.0:public:scripts —— 編進網站的程式碼取代宣告式插件的 manifest.scripts。
//   - scripts 與 override 共用一個解析器:同樣的值、同樣的上限,來源出錯同樣是 null
//   - 登記了 override:掛 override,不看核准、不輸出任何 manifest script
//   - 沒登記:與 1.50.0 相同(核准過才輸出 script)
//   - interpret 真的照這個規則把 widget 掛進 filter:publicWidgets

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => (env as { STORAGE?: unknown }).STORAGE,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-nonce": "abcdefghijklmnopqrstuv==" }),
}));

const settingsState = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback: unknown) =>
    settingsState.values.has(key) ? settingsState.values.get(key) : fallback,
}));

const contentState = vi.hoisted(() => ({
  items: new Map<string, unknown[]>(),
  failing: new Set<string>(),
}));
vi.mock("@/ext/dx/content-cache", () => ({
  cachedPublicQuery: async (_extId: string, type: string) => {
    if (contentState.failing.has(type)) throw new Error(`${type} is down`);
    return { items: contentState.items.get(type) ?? [] };
  },
  cachedExtStylesheet: async () => null,
}));

const feedState = vi.hoisted(() => ({ recentPurchases: async (): Promise<unknown> => [] }));
vi.mock("@/ext/loader", () => ({
  getExtRuntime: async () => ({
    byId: (id: string) =>
      id === "shop" ? { publicFeeds: { recentPurchases: () => feedState.recentPurchases() } } : undefined,
  }),
}));

// interpret.tsx 經 views 拉進 next/link 等 client 相依,在 workers pool 載不起來
// (見 ext-runtime-safety.test.ts)。這裡測的是浮層插槽,views 換成空殼。
vi.mock("@/ext/dx/views/CollectionView", () => ({ CollectionView: () => null }));
vi.mock("@/ext/dx/views/InboxView", () => ({ InboxView: () => null }));
vi.mock("@/ext/dx/views/FormViewPage", () => ({ FormViewPage: () => null }));
vi.mock("@/ext/dx/views/FormView", () => ({ FormView: () => null }));
vi.mock("@/ext/dx/views/ListView", () => ({ ListView: () => null }));
vi.mock("@/ext/dx/views/DetailView", () => ({ DetailView: () => null }));

import { overrideRegistry, type ScriptsSurfaceProps } from "../src/ext/overrides";
import { surfaceIds } from "../src/ext/dx/surfaces";
import { hashScripts } from "../src/ext/dx/scripts";
import {
  makeScriptsWidget,
  publicScriptsWidget,
  scriptInputsResolver,
} from "../src/ext/dx/scripts-widget";
import { interpretManifest } from "../src/ext/dx/interpret";
import { parseManifest, type DeclarativeManifest } from "../src/ext/dx/manifest";

const d1 = () => (env as { DB: D1Database }).DB;

const INLINE =
  "x([{{settings.label}},{{settings.max}},{{content.sample}},{{content.catalog.product}},{{feed.shop.recentPurchases}}])";

function manifestFor(id: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "declarative",
    id,
    name: id,
    version: "1.0.0",
    coreApi: "^1.51.0",
    contentTypes: [
      { name: "sample", label: "Sample", fields: [{ key: "product", type: "text", label: "Product" }] },
    ],
    settings: [
      { key: "label", label: "Label", type: "text", default: "示意" },
      { key: "max", label: "Max", type: "number", default: 4 },
    ],
    scripts: [{ inline: INLINE }],
    ...extra,
  };
}

function parsed(raw: Record<string, unknown>): DeclarativeManifest {
  const result = parseManifest(raw);
  expect(result.error).toBeUndefined();
  return result.manifest!;
}

// 登記的元件:把收到的 props 印成 JSON,渲染結果就能直接比。
const Received = ((props: ScriptsSurfaceProps) =>
  createElement("output", { "data-received": JSON.stringify(props) })) as ComponentType<ScriptsSurfaceProps>;

const COMPILED = "proof";
const PLAIN = "plain";

type Widget = () => Promise<ReactElement | null>;
const run = (widget: ComponentType | null) => (widget as unknown as Widget)();

const unescapeAttr = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** 渲染 widget,拿回 override 收到的 props(沒有就是 null)與整段 HTML。 */
async function render(widget: ComponentType | null) {
  const element = await run(widget);
  const html = element ? renderToStaticMarkup(element) : "";
  const match = html.match(/data-received="([^"]*)"/);
  const received = match ? (JSON.parse(unescapeAttr(match[1])) as ScriptsSurfaceProps) : null;
  return { html, received };
}

const approvalFor = async (m: DeclarativeManifest) =>
  JSON.stringify({ hash: await hashScripts(m.scripts ?? []), by: "a@t.co", at: 1 });

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
  // 別的插件的型別({{content.catalog.product}})只給標題:標題欄位從它的 manifest 找。
  const catalog = {
    kind: "declarative",
    id: "catalog",
    name: "Catalog",
    version: "1.0.0",
    coreApi: "^1.0.0",
    contentTypes: [
      { name: "product", label: "Product", slugField: "title", fields: [{ key: "title", type: "text", label: "Title" }] },
    ],
  };
  await d1().prepare("DELETE FROM declarative_extensions WHERE id = 'catalog'").run();
  await d1()
    .prepare("INSERT INTO declarative_extensions (id, manifest, version, enabled, installed_at, updated_at) VALUES ('catalog', ?, '1.0.0', 1, 1, 1)")
    .bind(JSON.stringify(catalog))
    .run();
  if (!overrideRegistry.has(COMPILED, surfaceIds.publicScripts())) {
    overrideRegistry.register(COMPILED, surfaceIds.publicScripts(), "scripts", Received);
  }
});

beforeEach(() => {
  settingsState.values = new Map([[`ext.${COMPILED}.label`, "Sample"], [`ext.${PLAIN}.label`, "Sample"]]);
  contentState.failing = new Set();
  contentState.items = new Map<string, unknown[]>([
    [`${COMPILED}.sample`, [{ id: "s1", slug: null, data: { product: "蘋果派" } }]],
    [`${PLAIN}.sample`, [{ id: "s1", slug: null, data: { product: "蘋果派" } }]],
    ["catalog.product", [{ id: "p1", slug: "black-tea", data: { title: "紅茶", price: 60 } }]],
  ]);
  feedState.recentPurchases = async () => [{ product: "檸檬塔", more: 1, at: new Date(60_000), note: undefined }];
});

describe("override registry: public:scripts", () => {
  it("takes one component per extension, bound to the scripts props", () => {
    expect(overrideRegistry.has(COMPILED, "public:scripts")).toBe(true);
    expect(overrideRegistry.list(COMPILED)).toEqual(["public:scripts"]);
    expect(() =>
      overrideRegistry.register(COMPILED, surfaceIds.publicScripts(), "scripts", Received),
    ).toThrow(/duplicate/);
    // view 參數要跟 surfaceId 的 view 段一致,否則元件會拿到別的 surface 的 props。
    expect(() =>
      overrideRegistry.register("other", "public:scripts", "detail", () => null),
    ).toThrow(/does not match/);
  });
});

describe("scriptInputsResolver", () => {
  it("resolves settings with defaults and each data ref by its path", async () => {
    settingsState.values.delete(`ext.${COMPILED}.label`);
    const { settings, data } = await scriptInputsResolver(COMPILED, parsed(manifestFor(COMPILED)))();
    expect(settings).toEqual({ label: "示意", max: 4 });
    expect(data["content.sample"]).toEqual([{ id: "s1", slug: null, data: { product: "蘋果派" } }]);
    expect(data["content.catalog.product"]).toEqual([{ id: "p1", slug: "black-tea", title: "紅茶" }]);
    expect(data["feed.shop.recentPurchases"]).toEqual([
      { product: "檸檬塔", more: 1, at: new Date(60_000), note: undefined },
    ]);
  });

  it("gives null for a source that fails and keeps the rest", async () => {
    contentState.failing.add("catalog.product");
    feedState.recentPurchases = async () => {
      throw new Error("feed down");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { data } = await scriptInputsResolver(COMPILED, parsed(manifestFor(COMPILED)))();
      expect(data["content.catalog.product"]).toBeNull();
      expect(data["feed.shop.recentPurchases"]).toBeNull();
      expect(data["content.sample"]).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("caps oversized data the same way for both paths", async () => {
    contentState.items.set(
      `${COMPILED}.sample`,
      Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, slug: null, data: { product: "x".repeat(2000) } })),
    );
    const { data } = await scriptInputsResolver(COMPILED, parsed(manifestFor(COMPILED)))();
    const capped = data["content.sample"] as unknown[];
    expect(capped.length).toBeLessThan(50);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(32_000);
  });
});

describe("publicScriptsWidget", () => {
  it("mounts the override instead of the scripts, without an approval", async () => {
    const manifest = parsed(manifestFor(COMPILED));
    const { html, received } = await render(publicScriptsWidget(COMPILED, manifest, null));
    expect(html).not.toContain("<script");
    expect(received).toMatchObject({ extId: COMPILED, locale: "en", settings: { label: "Sample", max: 4 } });
    // 核准過也一樣:登記了就不輸出 script。
    const approved = await render(publicScriptsWidget(COMPILED, manifest, await approvalFor(manifest)));
    expect(approved.html).not.toContain("<script");
    expect(approved.received).not.toBeNull();
  });

  it("hands the override exactly the values the inline script would see", async () => {
    // 同一份 manifest 走 scripts(未登記 override 的 id)與 override,各自渲染後比對。
    const plain = parsed(manifestFor(PLAIN));
    const scriptHtml = renderToStaticMarkup((await run(makeScriptsWidget(PLAIN, plain, JSON.parse(await approvalFor(plain)))))!);
    const literal = scriptHtml.match(/<script[^>]*>x\((.*)\)<\/script>/)?.[1];
    expect(literal).toBeTruthy();
    const seenByScript = JSON.parse(literal!) as unknown[];

    const { received } = await render(publicScriptsWidget(COMPILED, parsed(manifestFor(COMPILED)), null));
    const s = received!.settings;
    const d = received!.data;
    expect([s.label, s.max, d["content.sample"], d["content.catalog.product"], d["feed.shop.recentPurchases"]]).toEqual(
      seenByScript,
    );
    // JSON 化過:Date 變字串、undefined 欄位消失 —— 跟 script 裡的一樣。
    expect(d["feed.shop.recentPurchases"]).toEqual([{ product: "檸檬塔", more: 1, at: "1970-01-01T00:01:00.000Z" }]);
  });

  it("keeps 1.50.0 behaviour without an override", async () => {
    const manifest = parsed(manifestFor(PLAIN));
    expect(publicScriptsWidget(PLAIN, manifest, null)).toBeNull();
    const { html, received } = await render(publicScriptsWidget(PLAIN, manifest, await approvalFor(manifest)));
    expect(html).toContain('<script data-ext="plain" nonce="abcdefghijklmnopqrstuv==">x([');
    expect(received).toBeNull();
  });

  it("mounts nothing when the manifest has no scripts to replace", () => {
    const manifest = parsed(manifestFor(COMPILED, { scripts: undefined }));
    expect(publicScriptsWidget(COMPILED, manifest, null)).toBeNull();
  });
});

describe("interpretManifest: the public widget slot", () => {
  async function slot(id: string, approval: string | null) {
    const result = interpretManifest({
      id,
      manifest: JSON.stringify(manifestFor(id)),
      version: "1.0.0",
      enabled: 1,
      scriptsApproval: approval,
    });
    expect(result.status).toBe("ready");
    const filter = result.status === "ready" ? result.extension.hooks?.["filter:publicWidgets"] : undefined;
    if (!filter) return null;
    const widgets = (await filter([])) as ComponentType[];
    expect(widgets).toHaveLength(1);
    return render(widgets[0]);
  }

  it("mounts the compiled component, emits no manifest script and needs no approval", async () => {
    const out = await slot(COMPILED, null);
    expect(out).not.toBeNull();
    expect(out!.html).not.toContain("<script");
    expect(out!.received?.data["content.catalog.product"]).toEqual([{ id: "p1", slug: "black-tea", title: "紅茶" }]);
  });

  it("mounts the approved scripts when nothing is compiled in, and nothing without approval", async () => {
    expect(await slot(PLAIN, null)).toBeNull();
    const approval = await approvalFor(parsed(manifestFor(PLAIN)));
    const out = await slot(PLAIN, approval);
    expect(out!.html).toContain("<script");
    expect(out!.received).toBeNull();
  });
});
