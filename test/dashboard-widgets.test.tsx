import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.62.0:插件放在儀表板上的卡片(Extension.dashboardWidgets + metrics)。宣告的規則、每次呼叫的隔離與
// 逾時、資料的驗證、看的人打不打得開、同一個 metric 合成一張卡、比前一段,與畫在儀表板上的樣子。

const state = vi.hoisted(() => ({
  exts: [] as unknown[],
  access: null as Record<string, "view" | "edit"> | null,
  currency: "TWD",
}));

vi.mock("@/lib/cf", () => ({
  getEnv: () => env,
  getDB: () => (env as { DB: unknown }).DB,
  getStorage: () => undefined,
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/ext/dx/type-directory", () => ({ listDeclarativeTypes: async () => [] }));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({ enabled: state.exts }) }));
vi.mock("@/lib/i18n/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/i18n/server")>();
  return { ...actual, getLocale: async () => "zh-Hant" };
});
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionAccess: async () => ({ user: { id: "u1", role: "admin" }, access: state.access }),
}));
vi.mock("@/lib/access-guards", () => ({ guardDashboard: async () => {} }));
vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string, fallback: unknown) => (key === "core.currency" ? state.currency : fallback),
}));
vi.mock("@/lib/datetime-server", () => ({ getSiteTimeZone: async () => "Asia/Taipei" }));
vi.mock("@/components/admin/StatNumber", () => ({
  StatNumber: ({ value, locales }: { value: number; locales?: Intl.LocalesArgument }) =>
    createElement("span", null, new Intl.NumberFormat(locales).format(value)),
}));

import { DASHBOARD_WIDGET_TIMEOUT_MS, loadDashboardWidgets, type DashboardWidgetOptions } from "../src/ext/dx/dashboard-widgets";
import { buildPluginCards } from "../src/components/admin/dashboard/widget-cards";
import { dashboardViewer } from "../src/components/admin/dashboard/viewer";
import DashboardPage from "../src/app/(admin)/admin/page";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import { defineExtension, type DashboardWidgetDecl, type Extension, type MetricDecl, type WidgetContext, type WidgetData } from "../src/ext/types";

const d1 = () => (env as { DB: D1Database }).DB;
const NOW = Date.UTC(2026, 8, 23, 4, 0); // 台北 9/23 12:00
const opts = (extra: Partial<DashboardWidgetOptions> = {}): DashboardWidgetOptions => ({
  params: new URLSearchParams("range=7"),
  now: NOW,
  timeZone: "Asia/Taipei",
  locale: "zh-Hant",
  ...extra,
});

/** 中性的共用數字:兩個插件各交一條每日金額。 */
const SALES: MetricDecl = { key: "orders.amount", label: { "zh-Hant": "訂單金額", en: "Order amount" }, unit: { kind: "currency" }, combine: "sum" };
const ext = (id: string, more: Partial<Extension> = {}): Extension => ({
  id,
  name: { en: `${id} plugin`, "zh-Hant": `${id} 插件` },
  version: "1.0.0",
  coreApi: "^1.62.0",
  ...more,
});
const widget = (id: string, load: DashboardWidgetDecl["load"], more: Partial<DashboardWidgetDecl> = {}): DashboardWidgetDecl => ({
  id,
  kind: "number",
  title: `Title ${id}`,
  href: `/admin/ext/wid/${id}`,
  load,
  ...more,
});
const number = (value: number, spark?: number[]): WidgetData => ({ kind: "number", value, ...(spark ? { spark } : {}) });
/** 這一段(期間到今天為止)還是前一段。 */
const isCurrent = (ctx: WidgetContext) => ctx.period!.end > ctx.now;
/** 每日一條線:這一段最後一天是 current,前一段最後一天是 previous。 */
const daily = (id: string, current: number, previous: number, href = `/admin/ext/${id}`) =>
  widget(
    id,
    async (ctx) => ({
      kind: "timeseries",
      bucket: "day",
      series: [{ id, label: `${id} 線`, href, points: { [ctx.period!.to]: isCurrent(ctx) ? current : previous } }],
    }),
    { kind: "timeseries", title: undefined, metric: SALES.key, period: true, href: undefined },
  );
const keys = (list: { key: string }[]) => list.map((c) => c.key);
const labels = { vsPrevious: "比前 {days} 天", vsPreviousDay: "比前一天", noPrevious: "前 {days} 天沒有{label}", noPreviousDay: "前一天沒有{label}" };

let errors: MockInstance<typeof console.error>;
beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT DEFAULT 'draft' NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
});
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  state.exts = [];
  state.access = null;
  state.currency = "TWD";
});
afterEach(() => {
  errors.mockRestore();
});

describe("declaring widgets and metrics", () => {
  const valid = () =>
    ext("wid", {
      metrics: [SALES],
      dashboardWidgets: [widget("n", async () => number(1)), daily("d", 1, 1)],
    });

  it("defineExtension accepts the contract", () => {
    expect(() => defineExtension(valid())).not.toThrow();
  });

  it("both fields need coreApi ^1.62.0", () => {
    expect(() => defineExtension({ ...valid(), coreApi: "^1.61.0" })).toThrow(/dashboardWidgets requires coreApi "\^1\.62\.0"/);
    expect(() => defineExtension({ ...valid(), coreApi: "^1.61.0", dashboardWidgets: undefined })).toThrow(/metrics requires coreApi "\^1\.62\.0"/);
  });

  it.each([
    ["no title and no metric", { title: undefined }, /needs a title/],
    ["a unit next to a metric", { metric: SALES.key, unit: { kind: "count" as const } }, /takes the metric's unit/],
    ["a title next to a metric", { metric: SALES.key }, /titled by the metric's label; leave title out/],
    ["a metric the plugin does not declare", { metric: SALES.key, title: undefined }, /widget "n" uses metric "orders.amount", which this plugin does not declare in metrics/],
    ["a list with a unit", { kind: "list" as const, unit: { kind: "count" as const } }, /list widget has no metric or unit/],
    ["a timeseries without period", { kind: "timeseries" as const }, /needs period: true/],
    ["an external href", { href: "https://example.com/admin" }, /admin path/],
    ["a bad id", { id: "Bad_Id" }, /invalid widget id/],
    ["a bad currency", { unit: { kind: "currency" as const, code: "NTD" } }, /ISO 4217/],
    ["a title that is too long", { title: "x".repeat(61) }, /at most 60/],
    ["an unknown field", { layout: "wide" } as Partial<DashboardWidgetDecl>, /Unrecognized key/],
  ])("refuses %s", (_label, change, message) => {
    const bad = ext("wid", { dashboardWidgets: [{ ...widget("n", async () => number(1)), ...change }] });
    expect(() => defineExtension(bad)).toThrow(message);
  });

  it("refuses repeated ids and keys, and more than 12 widgets", () => {
    const load = async () => number(1);
    expect(() => defineExtension(ext("wid", { dashboardWidgets: [widget("a", load), widget("a", load)] }))).toThrow(/duplicate id "a"/);
    expect(() => defineExtension(ext("wid", { metrics: [SALES, SALES] }))).toThrow(/duplicate key "orders.amount"/);
    expect(() => defineExtension(ext("wid", { metrics: [{ ...SALES, key: "revenue" }] }))).toThrow(/<namespace>.<name>/);
    // 負數一律不收,沒有可以打開的選項。
    expect(() => defineExtension(ext("wid", { metrics: [{ ...SALES, allowNegative: true } as MetricDecl] }))).toThrow(/Unrecognized key/);
    const many = Array.from({ length: 13 }, (_, i) => widget(`w${i}`, load));
    expect(() => defineExtension(ext("wid", { dashboardWidgets: many }))).toThrow(/dashboardWidgets/);
  });
});

describe("calling load", () => {
  it("hands each widget the site context, and the period only to period widgets", async () => {
    const seen: WidgetContext[] = [];
    const record = async (ctx: WidgetContext) => ((seen.push(ctx), number(1)));
    await loadDashboardWidgets([ext("wid", { dashboardWidgets: [widget("now", record), widget("p", record, { period: true })] })], opts());
    const [now, current, previous] = seen;
    expect(now).toMatchObject({ now: NOW, timeZone: "Asia/Taipei", locale: "zh-Hant" });
    expect(now.period).toBeUndefined();
    expect(now.canOpen("/admin/anything")).toBe(true);
    expect([current.period, previous.period]).toEqual(
      expect.arrayContaining([
        { from: "2026-09-17", to: "2026-09-23", start: Date.UTC(2026, 8, 16, 16), end: Date.UTC(2026, 8, 23, 16) },
        { from: "2026-09-10", to: "2026-09-16", start: Date.UTC(2026, 8, 9, 16), end: Date.UTC(2026, 8, 16, 16) },
      ]),
    );
  });

  it("gives each call its own ctx", async () => {
    const meddler = widget("m", async (ctx) => {
      (ctx as { timeZone: string }).timeZone = "UTC";
      return number(1);
    });
    let seen: string | undefined;
    const reader = widget("r", async (ctx) => ((seen = ctx.timeZone), number(1)));
    await loadDashboardWidgets([ext("a", { dashboardWidgets: [meddler] }), ext("b", { dashboardWidgets: [reader] })], opts());
    expect(seen).toBe("Asia/Taipei");
  });

  const healthy = () => ext("healthy", { dashboardWidgets: [widget("ok", async () => number(5))] });
  it.each([
    ["throws synchronously", () => { throw new Error("boom"); }, "failed; skipped"],
    ["rejects", async () => { throw new Error("boom"); }, "failed; skipped"],
    ["answers with nothing", async () => undefined, "not an object"],
    ["answers with a list", async () => [], "not an object"],
    ["answers with another kind", async () => ({ kind: "list", items: [] }), 'returned kind "list", expected "number"'],
  ])("a widget that %s is not drawn, with one log line, and the rest still are", async (_label, load, message) => {
    const broken = ext("broken", { dashboardWidgets: [widget("x", load as DashboardWidgetDecl["load"])] });
    const data = await loadDashboardWidgets([broken, healthy()], opts());
    expect(keys(data.cards)).toEqual(["healthy:widget:ok"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(`[dashboard-widgets] ext="broken" dashboardWidgets["x"]`);
    expect(String(errors.mock.calls[0][0])).toContain(message);
  });

  it("null means not this time, without a log line", async () => {
    const data = await loadDashboardWidgets([ext("quiet", { dashboardWidgets: [widget("x", async () => null)] }), healthy()], opts());
    expect(keys(data.cards)).toEqual(["healthy:widget:ok"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a widget that takes too long is skipped at the time limit", async () => {
    const started = Date.now();
    const slow = ext("slow", { dashboardWidgets: [widget("x", () => new Promise((resolve) => setTimeout(() => resolve(number(1)), 400)))] });
    const data = await loadDashboardWidgets([slow, healthy()], opts({ timeoutMs: 50 }));
    expect(keys(data.cards)).toEqual(["healthy:widget:ok"]);
    expect(Date.now() - started).toBeLessThan(350);
    expect(String(errors.mock.calls[0][0])).toContain('ext="slow" dashboardWidgets["x"] took longer than 50ms');
    expect(DASHBOARD_WIDGET_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it("a throw after load (checking the data, the previous period) skips only that widget, with one log line", async () => {
    const lines = widget(
      "d",
      async () => ({ kind: "timeseries", bucket: "day", series: [{ id: "x", label: "X", href: "/admin/ext/boom", points: {} }] }),
      { kind: "timeseries", period: true, href: undefined },
    );
    const canOpen = (href: string) => {
      if (href === "/admin/ext/boom") throw new Error("boom");
      return true;
    };
    const data = await loadDashboardWidgets([ext("broken", { dashboardWidgets: [lines] }), healthy()], opts({ canOpen }));
    expect(keys(data.cards)).toEqual(["healthy:widget:ok"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toBe('[dashboard-widgets] ext="broken" dashboardWidgets["d"] could not be drawn (boom); skipped');
  });

  it("a custom range in the year 1000 falls back to the default period", async () => {
    const seen: string[] = [];
    const record = async (ctx: WidgetContext) => ((seen.push(ctx.period!.from), number(1)));
    const data = await loadDashboardWidgets([ext("wid", { dashboardWidgets: [widget("p", record, { period: true })] })], opts({ params: new URLSearchParams("since=1000-01-01&until=1000-01-10") }));
    expect(data.period).toMatchObject({ preset: 30, from: "2026-08-25", to: "2026-09-23" });
    expect(seen.sort()).toEqual(["2026-07-26", "2026-08-25"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("an invalid declaration that bypassed defineExtension is skipped with a log line", async () => {
    const raw = ext("raw", { dashboardWidgets: [{ ...widget("Bad_Id", async () => number(1)) }, widget("ok", async () => number(1))] });
    const data = await loadDashboardWidgets([raw], opts());
    expect(keys(data.cards)).toEqual(["raw:widget:ok"]);
    expect(String(errors.mock.calls[0][0])).toContain('ext="raw" widget[0] id: invalid widget id; skipped');
  });
});

describe("checking what load returns", () => {
  const run = async (w: DashboardWidgetDecl, metrics?: MetricDecl[]) => loadDashboardWidgets([ext("wid", { dashboardWidgets: [w], metrics })], opts());

  it("numbers are finite and never negative, with or without a metric", async () => {
    expect((await run(widget("n", async () => number(Number.NaN)))).cards).toEqual([]);
    expect((await run(widget("s", async () => number(1, [1, Number.POSITIVE_INFINITY])))).cards).toEqual([]);
    expect((await run(widget("free", async () => number(-3)))).cards).toEqual([]);
    expect((await run(widget("spark", async () => number(3, [1, -1])))).cards).toEqual([]);
    const counted: MetricDecl = { key: "orders.count", label: "訂單", unit: { kind: "count" }, combine: "sum" };
    expect((await run(widget("m", async () => number(-3), { metric: counted.key, title: undefined }), [counted])).cards).toEqual([]);
    expect((await run(widget("m", async () => number(0), { metric: counted.key, title: undefined }), [counted])).cards).toHaveLength(1);
  });

  it("a series with one bad day is dropped whole, with a log line; the others stay", async () => {
    const lines = (series: unknown[]) => widget("d", async (ctx) => (isCurrent(ctx) ? { kind: "timeseries", bucket: "day", series } : null) as WidgetData | null, { kind: "timeseries", period: true });
    const good = { id: "good", label: "好", points: { "2026-09-20": 5 } };
    const drawnAfter = async (bad: unknown[]) => {
      errors.mockClear();
      const [card] = (await run(lines([good, ...bad]))).cards;
      expect(card.data).toEqual({ kind: "timeseries", series: [{ key: "wid/d/good", id: "good", label: "好", points: { "2026-09-20": 5 } }] });
      return errors.mock.calls.map((c) => String(c[0]));
    };
    expect(
      await drawnAfter([
        { id: "before", label: "早", points: { "2026-09-16": 1 } },
        { id: "fake-day", label: "假", points: { "2026-02-30": 1 } },
        { id: "nan", label: "空", points: { "2026-09-20": Number.NaN } },
      ]),
    ).toEqual([
      expect.stringContaining('series[1] "before" day "2026-09-16" is not a date from 2026-09-17 to 2026-09-23; dropped'),
      expect.stringContaining('series[2] "fake-day" day "2026-02-30"'),
      expect.stringContaining('series[3] "nan" day "2026-09-20" must be a finite number'),
    ]);
    expect(
      await drawnAfter([
        { id: "long", label: "x".repeat(41), points: {} },
        { id: "external", label: "外", href: "https://example.com", points: {} },
        { id: "good", label: "重複", points: {} },
      ]),
    ).toEqual([
      expect.stringContaining('series[1] "long" needs a label of at most 40'),
      expect.stringContaining('series[2] "external" href must be an admin path'),
      expect.stringContaining('series[3] repeats id "good"'),
    ]);
  });

  it("at most four series, and only those four are checked; a chart with none left is not drawn", async () => {
    const many = widget(
      "d",
      async () => ({ kind: "timeseries", bucket: "day", series: Array.from({ length: 6 }, (_, i) => ({ id: i < 4 ? `s${i}` : "Bad_Id", label: `s${i}`, points: {} })) }),
      { kind: "timeseries", period: true },
    );
    const [card] = (await run(many)).cards;
    expect(card.data.kind === "timeseries" && card.data.series.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3"]);
    // 這一段與前一段各一行,都只說多了;第 5、6 條沒驗。
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('dashboardWidgets["d"] returned 6 series; only the first 4 are shown'),
      expect.stringContaining('dashboardWidgets["d"] returned 6 series; only the first 4 are shown'),
    ]);
    const none = widget("e", async () => ({ kind: "timeseries", bucket: "day", series: [] }), { kind: "timeseries", period: true });
    expect((await run(none)).cards).toEqual([]);
  });

  it("a proportion with one bad segment is not drawn; a good one keeps its total", async () => {
    const pie = (segments: unknown[], total?: number) =>
      widget("p", async () => ({ kind: "proportion", segments, ...(total !== undefined ? { total } : {}) }) as WidgetData, { kind: "proportion" });
    expect((await run(pie([{ id: "a", label: "A", value: 1 }, { id: "b", label: "B", value: -1 }]))).cards).toEqual([]);
    expect((await run(pie([]))).cards).toEqual([]);
    const [card] = (await run(pie([{ id: "a", label: { "zh-Hant": "甲", en: "A" }, value: 3 }], 10))).cards;
    expect(card.data).toEqual({ kind: "proportion", segments: [{ key: "wid/p/a", id: "a", label: "甲", value: 3 }], total: 10 });
  });

  it("list rows are checked one by one, at most ten", async () => {
    const rows = [
      { id: "a", title: "第一筆", href: "/admin/ext/wid?id=a", at: NOW - 60_000 },
      { id: "b", title: "", href: "/admin/ext/wid" },
      { id: "c", title: "外面", href: "https://example.com" },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: `列 ${i}` })),
    ];
    const [card] = (await run(widget("l", async () => ({ kind: "list", items: rows }), { kind: "list" }))).cards;
    expect(card.data.kind === "list" && card.data.items.map((item) => item.id)).toEqual(["a", "r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(errors).toHaveBeenCalledTimes(3);
  });
});

describe("who sees what", () => {
  it("a widget whose page the viewer can't open is not called; an unlinked number is admin-only", async () => {
    const calls: string[] = [];
    const track = (id: string) => async () => ((calls.push(id), number(1)));
    const w = ext("wid", {
      dashboardWidgets: [
        widget("own", track("own"), { href: "/admin/ext/wid" }),
        widget("other", track("other"), { href: "/admin/ext/other" }),
        widget("unlinked", track("unlinked"), { href: undefined }),
        widget("everyone", track("everyone"), { href: "/admin" }),
      ],
    });
    const viewer = dashboardViewer({ "/admin/ext/wid": "view", "/admin": "view" })!;
    const data = await loadDashboardWidgets([w], opts({ canOpen: viewer.canOpen }));
    expect(keys(data.cards)).toEqual(["wid:widget:own", "wid:widget:everyone"]);
    expect(calls.sort()).toEqual(["everyone", "own"]);
    expect(errors).not.toHaveBeenCalled();
    expect(keys((await loadDashboardWidgets([w], opts())).cards)).toHaveLength(4);
  });

  it("series and rows follow their own links; without one they follow the widget's", async () => {
    const lines = widget(
      "d",
      async () => ({
        kind: "timeseries",
        bucket: "day",
        series: [
          { id: "own", label: "自己", href: "/admin/ext/wid", points: {} },
          { id: "other", label: "別人", href: "/admin/ext/other", points: {} },
          { id: "bare", label: "沒連結", points: {} },
        ],
      }),
      { kind: "timeseries", period: true, href: undefined },
    );
    const viewer = dashboardViewer({ "/admin/ext/wid": "view" })!;
    const seriesOf = async (w: DashboardWidgetDecl) => {
      const [card] = (await loadDashboardWidgets([ext("wid", { dashboardWidgets: [w] })], opts({ canOpen: viewer.canOpen }))).cards;
      return card.data.kind === "timeseries" ? card.data.series.map((s) => s.id) : [];
    };
    expect(await seriesOf(lines)).toEqual(["own"]);
    expect(await seriesOf({ ...lines, href: "/admin/ext/wid" })).toEqual(["own", "bare"]);
  });
});

describe("metrics", () => {
  it("widgets on the same metric from two plugins make one card, in the first plugin's place", async () => {
    const a = ext("a", { metrics: [SALES], dashboardWidgets: [widget("first", async () => number(1)), daily("a-orders", 300, 200)] });
    const b = ext("b", { metrics: [{ ...SALES }], dashboardWidgets: [daily("b-orders", 100, 100)] });
    const data = await loadDashboardWidgets([a, b], opts());
    // 合成的卡用第一個插件那一張的 key。
    expect(keys(data.cards)).toEqual(["a:widget:first", "a:widget:a-orders"]);
    const merged = data.cards[1];
    expect(merged).toMatchObject({ title: "訂單金額", extNames: ["a 插件", "b 插件"], unit: { kind: "currency" }, previous: 300 });
    expect(merged.data.kind === "timeseries" && merged.data.series.map((s) => s.key)).toEqual(["a/a-orders/a-orders", "b/b-orders/b-orders"]);
    expect(errors).not.toHaveBeenCalled();
    expect(data.period).toMatchObject({ preset: 7, from: "2026-09-17", to: "2026-09-23" });
  });

  it("numbers on a summed metric add up, and so do their previous values", async () => {
    const count: MetricDecl = { key: "orders.count", label: "訂單數", unit: { kind: "count" }, combine: "sum" };
    const w = (id: string, v: number) => widget(id, async (ctx) => number(isCurrent(ctx) ? v : v / 2), { metric: count.key, title: undefined, period: true });
    const data = await loadDashboardWidgets([ext("a", { metrics: [count], dashboardWidgets: [w("x", 4)] }), ext("b", { metrics: [count], dashboardWidgets: [w("y", 6)] })], opts());
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0]).toMatchObject({ title: "訂單數", data: { kind: "number", value: 10 }, previous: 5 });
  });

  it("two widgets of one plugin on one metric may both name a series \"total\": the totals and the change still add up", async () => {
    const total = (id: string, current: number, previous: number) =>
      widget(
        id,
        async (ctx) => ({ kind: "timeseries", bucket: "day", series: [{ id: "total", label: `${id} 合計`, points: { [ctx.period!.to]: isCurrent(ctx) ? current : previous } }] }),
        { kind: "timeseries", title: undefined, metric: SALES.key, period: true },
      );
    const data = await loadDashboardWidgets([ext("wid", { metrics: [SALES], dashboardWidgets: [total("store", 300, 200), total("online", 100, 100)] })], opts());
    expect(data.cards).toHaveLength(1);
    const [card] = data.cards;
    expect(card.data.kind === "timeseries" && card.data.series.map((s) => s.key)).toEqual(["wid/store/total", "wid/online/total"]);
    expect(card.previous).toBe(300);
    const [drawn] = buildPluginCards(data, { locale: "zh-Hant", currency: "TWD", labels }).timeseries;
    expect(drawn.total).toBe("NT$ 400");
    expect(drawn.comparison).toEqual({ kind: "delta", delta: { value: 33, direction: "up", caption: "比前 7 天" } });
    expect(errors).not.toHaveBeenCalled();
  });

  it("the first declaration of a metric wins: a plugin that declares it differently loses only its own widgets on it", async () => {
    const a = ext("a", { metrics: [SALES], dashboardWidgets: [daily("a-orders", 1, 1)] });
    const b = ext("b", { metrics: [{ ...SALES, unit: { kind: "count" } }], dashboardWidgets: [daily("b-orders", 1, 1)] });
    // 名字照每種語言比:key 的順序不同還是同一個宣告;有一種語言的名字不一樣就不是。
    const c = ext("c", { metrics: [{ ...SALES, label: { en: "Order amount", "zh-Hant": "訂單金額" } }], dashboardWidgets: [daily("c-orders", 1, 1)] });
    const d = ext("d", { metrics: [{ ...SALES, label: { "zh-Hant": "訂單總額", en: "Order amount" } }], dashboardWidgets: [daily("d-orders", 1, 1)] });
    const data = await loadDashboardWidgets([a, b, c, d], opts());
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0].data.kind === "timeseries" && data.cards[0].data.series.map((s) => s.key)).toEqual(["a/a-orders/a-orders", "c/c-orders/c-orders"]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      '[dashboard-widgets] ext="b" declares metric "orders.amount" differently from "a", which comes first; its widgets on it are skipped',
      '[dashboard-widgets] ext="d" declares metric "orders.amount" differently from "a", which comes first; its widgets on it are skipped',
    ]);
  });

  it("a widget on a metric its own plugin does not declare is skipped, even when another plugin declares it", async () => {
    const a = ext("a", { metrics: [SALES], dashboardWidgets: [daily("a-orders", 1, 1)] });
    const lone = ext("lone", { dashboardWidgets: [daily("c", 1, 1)] });
    const data = await loadDashboardWidgets([a, lone], opts());
    expect(data.cards[0].data.kind === "timeseries" && data.cards[0].data.series.map((s) => s.key)).toEqual(["a/a-orders/a-orders"]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      '[dashboard-widgets] ext="lone" widget "c" uses metric "orders.amount", which this plugin does not declare; skipped',
    ]);
  });

  it("does not compare when a series is missing from the previous period", async () => {
    const flaky = widget(
      "f",
      async (ctx) => {
        if (!isCurrent(ctx)) throw new Error("previous failed");
        return { kind: "timeseries", bucket: "day", series: [{ id: "f", label: "F", points: { "2026-09-23": 5 } }] };
      },
      { kind: "timeseries", period: true },
    );
    const [card] = (await loadDashboardWidgets([ext("wid", { dashboardWidgets: [flaky] })], opts())).cards;
    expect(card.previous).toBeNull();
  });
});

describe("the cards as drawn", () => {
  it("writes numbers for their unit, the site currency when the unit has none, and the change", async () => {
    const points = { kind: "quantity" as const, label: { "zh-Hant": "點", en: "pts" }, decimals: 4 };
    const w = ext("wid", {
      dashboardWidgets: [
        widget("money", async (ctx) => number(isCurrent(ctx) ? 1500 : 1000), { unit: { kind: "currency" }, period: true }),
        widget("points", async () => number(1.5), { unit: points }),
        widget("share", async () => number(12.5), { unit: { kind: "percent" }, hint: "今天" }),
        widget("count", async () => number(3)),
      ],
    });
    const data = await loadDashboardWidgets([w], opts());
    const { numbers } = buildPluginCards(data, { locale: "zh-Hant", currency: "USD", labels });
    expect(numbers.map((n) => [n.text, n.hint])).toEqual([
      ["$ 1,500", "wid 插件"],
      ["1.5 點", "wid 插件"],
      ["12.5%", "今天"],
      [undefined, "wid 插件"],
    ]);
    expect(numbers[0].comparison).toEqual({ kind: "delta", delta: { value: 50, direction: "up", caption: "比前 7 天" } });
    expect(numbers[3].comparison).toBeNull();
  });
});

describe("on the dashboard", () => {
  const renderPage = async (searchParams: Record<string, string> = {}) => {
    const element = (await DashboardPage({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
    return renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, element));
  };

  it("draws numbers first, then one merged chart with the period control, then proportions and lists", { timeout: 30_000 }, async () => {
    state.currency = "USD";
    state.exts = [
      ext("a", {
        metrics: [SALES],
        dashboardWidgets: [
          daily("a-orders", 1200, 1000),
          widget("pending", async () => number(4), { title: "待處理" }),
          widget("mix", async () => ({ kind: "proportion", segments: [{ id: "x", label: "門市", value: 30 }, { id: "y", label: "網路", value: 70 }] }), { kind: "proportion", title: "來源", unit: { kind: "currency" } }),
          widget("latest", async () => ({ kind: "list", items: [{ id: "o1", title: "最新一筆", href: "/admin/ext/a?id=o1", at: NOW }] }), { kind: "list", title: "最近的單" }),
        ],
      }),
      ext("b", { metrics: [SALES], dashboardWidgets: [daily("b-orders", 300, 200)] }),
    ];
    const html = await renderPage({ range: "7" });
    const at = (text: string) => html.indexOf(text);
    expect(at("待處理")).toBeGreaterThan(-1);
    expect(at("訂單金額")).toBeGreaterThan(at("待處理"));
    expect(html).toContain("$ 1,500");
    expect(html).toContain("25%");
    expect(html).toContain("比前 7 天");
    expect(html).toContain('href="/admin/ext/a-orders"');
    expect(html).toContain('href="/admin/ext/b-orders"');
    expect(html.match(/aria-pressed="true"[^>]*>7 天</g)).toHaveLength(1);
    expect(at("來源")).toBeGreaterThan(at("訂單金額"));
    expect(html).toContain("$ 70");
    expect(at("最近的單")).toBeGreaterThan(at("來源"));
    expect(html).toContain('href="/admin/ext/a?id=o1"');
    expect(errors).not.toHaveBeenCalled();
  });

  it("with more than one period card the control sits once at the top of the section", { timeout: 30_000 }, async () => {
    state.exts = [
      ext("a", {
        metrics: [SALES],
        dashboardWidgets: [daily("a-orders", 1, 1), widget("period-number", async () => number(2), { title: "期間數字", period: true })],
      }),
    ];
    const html = await renderPage({ range: "30" });
    expect(html.match(/aria-pressed="true"[^>]*>30 天</g)).toHaveLength(1);
    expect(html.indexOf("aria-pressed")).toBeLessThan(html.indexOf("期間數字"));
  });
});
