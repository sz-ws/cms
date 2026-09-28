import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.61.0 的 Extension.dashboardRevenue,1.62.0 起走轉接(dx/dashboard-revenue.ts):宣告了它的插件等於宣告了
// commerce-kit 的 REVENUE 加一個 timeseries widget。這裡驗的是舊插件在 1.62.0 看起來跟 1.61.0 一樣 ——
// 同樣的規則、同樣的隔離、同樣的營業額卡(期間控制、合計、比前一段、疊加長條圖、圖例連結)—— 而且跟改用
// 新介面的插件疊在同一張卡上。

const state = vi.hoisted(() => ({
  exts: [] as unknown[],
  access: null as Record<string, "view" | "edit"> | null,
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
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/datetime-server", () => ({ getSiteTimeZone: async () => "Asia/Taipei" }));

import { loadDashboardWidgets, type DashboardWidgetOptions } from "../src/ext/dx/dashboard-widgets";
import { dashboardViewer } from "../src/components/admin/dashboard/viewer";
import DashboardPage from "../src/app/(admin)/admin/page";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import { REVENUE } from "../src/ext/commerce-kit/metrics";
import { defineExtension, type DashboardRevenueContext, type Extension, type RevenueSeries } from "../src/ext/types";

const d1 = () => (env as { DB: D1Database }).DB;
const NOW = Date.UTC(2026, 8, 23, 4, 0); // 台北 9/23 12:00
const opts = (extra: Partial<DashboardWidgetOptions> = {}): DashboardWidgetOptions => ({
  params: new URLSearchParams("range=7"),
  now: NOW,
  timeZone: "Asia/Taipei",
  locale: "zh-Hant",
  ...extra,
});
const series = (id: string, extra: Partial<RevenueSeries> = {}): RevenueSeries => ({
  id,
  label: `Label ${id}`,
  href: `/admin/ext/money/${id}`,
  days: { "2026-09-20": 100 },
  ...extra,
});
const ext = (id: string, load: Extension["dashboardRevenue"], more: Partial<Extension> = {}): Extension => ({
  id,
  name: { en: `${id} plugin`, "zh-Hant": `${id} 插件` },
  version: "1.0.0",
  coreApi: "^1.61.0",
  dashboardRevenue: load,
  ...more,
});
/** 這一段(到今天為止)還是前一段。 */
const isCurrent = (c: { end: number; now: number }) => c.end > c.now;
/** 畫出來的每條線的 key(`<extId>/<widgetId>/<id>`;轉接的 widget id 是 dashboard-revenue)。 */
const drawn = async (exts: Extension[], extra: Partial<DashboardWidgetOptions> = {}) => {
  const { cards } = await loadDashboardWidgets(exts, opts(extra));
  return cards.flatMap((card) => (card.data.kind === "timeseries" ? card.data.series.map((s) => s.key) : []));
};

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
});
afterEach(() => {
  errors.mockRestore();
});

describe("a plugin's dashboardRevenue through the adapter", () => {
  it("hands the plugin the period and draws its valid series on one REVENUE card, keyed by plugin", async () => {
    const seen: DashboardRevenueContext[] = [];
    const money = ext("money", async (c) => {
      seen.push(c);
      return [
        series("orders", { label: { en: "Orders", "zh-Hant": "訂單" }, href: "/admin/ext/money?range=7", days: { "2026-09-17": 10, "2026-09-23": 5.5 } }),
        series("zero", { days: {} }),
      ];
    });
    const other = ext("other", async (c) => (isCurrent(c) ? [series("orders", { href: "/admin/ext/other" })] : []));
    const { cards } = await loadDashboardWidgets([money, other], opts());
    expect(seen.find(isCurrent)).toMatchObject({ from: "2026-09-17", to: "2026-09-23", start: Date.UTC(2026, 8, 16, 16), end: Date.UTC(2026, 8, 23, 16), timeZone: "Asia/Taipei", locale: "zh-Hant" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "營業額", unit: REVENUE.unit, combine: "sum", period: true, extNames: ["money 插件", "other 插件"] });
    expect(cards[0].data).toEqual({
      kind: "timeseries",
      series: [
        { key: "money/dashboard-revenue/orders", id: "orders", label: "訂單", href: "/admin/ext/money?range=7", points: { "2026-09-17": 10, "2026-09-23": 5.5 } },
        { key: "money/dashboard-revenue/zero", id: "zero", label: "Label zero", href: "/admin/ext/money/zero", points: {} },
        { key: "other/dashboard-revenue/orders", id: "orders", label: "Label orders", href: "/admin/ext/other", points: { "2026-09-20": 100 } },
      ],
    });
  });

  it("gives each plugin its own ctx", async () => {
    const meddler = ext("meddler", async (c) => {
      (c as { from: string }).from = "2000-01-01";
      return [];
    });
    const seen: string[] = [];
    const reader = ext("reader", async (c) => ((seen.push(c.from), [])));
    await loadDashboardWidgets([meddler, reader], opts());
    expect(seen.sort()).toEqual(["2026-09-10", "2026-09-17"]);
  });

  it("defineExtension still accepts the hook (deprecated) and refuses a non-function", () => {
    expect(() => defineExtension(ext("money", async () => []))).not.toThrow();
    expect(() => defineExtension({ ...ext("money", undefined), dashboardRevenue: 5 } as unknown as Extension)).toThrow(/dashboardRevenue/);
  });
});

describe("series that break the 1.61.0 rules are still dropped", () => {
  it.each([
    ["is not an object", null, "series[1] is not an object"],
    ["has a bad id", series("Bad_Id"), "series[1] has an invalid id"],
    ["has an empty label", { ...series("no-label"), label: "  " }, 'series[1] "no-label" needs a label of at most 40'],
    ["has a label that is too long", series("long-label", { label: "x".repeat(41) }), 'series[1] "long-label" needs a label of at most 40'],
    ["links outside the admin", series("external", { href: "https://example.com/admin" }), 'series[1] "external" href must be an admin path'],
    ["has no href", { ...series("no-href"), href: undefined }, 'series[1] "no-href" href must be an admin path'],
    ["has a day before the period", series("before", { days: { "2026-09-16": 1, "2026-09-20": 5 } }), 'series[1] "before" day "2026-09-16" is not a date from 2026-09-17 to 2026-09-23'],
    ["has a day that does not exist", series("not-a-day", { days: { "2026-02-30": 1 } }), 'series[1] "not-a-day" day "2026-02-30"'],
    ["has a negative amount", series("negative", { days: { "2026-09-20": -1 } }), 'series[1] "negative" day "2026-09-20" must be at least 0'],
    ["has an amount that is not a number", series("nan", { days: { "2026-09-20": Number.NaN } }), 'series[1] "nan" day "2026-09-20" must be a finite number'],
    ["has an amount written as text", series("text", { days: { "2026-09-20": "5" as unknown as number } }), 'series[1] "text" day "2026-09-20" must be a finite number'],
    ["repeats an id", series("good", { label: "again" }), 'series[1] repeats id "good"'],
  ])("a series that %s is dropped whole, with one log line", async (_label, bad, message) => {
    const money = ext("money", async (c) => (isCurrent(c) ? ([series("good"), bad] as RevenueSeries[]) : []));
    expect(await drawn([money])).toEqual(["money/dashboard-revenue/good"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(`[dashboard-widgets] ext="money" dashboardRevenue ${message}`);
  });

  it("an amount of 0 is fine", async () => {
    const money = ext("money", async (c) => (isCurrent(c) ? [series("good"), series("zero-ok", { days: { "2026-09-20": 0 } })] : []));
    expect(await drawn([money])).toEqual(["money/dashboard-revenue/good", "money/dashboard-revenue/zero-ok"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("draws at most four series per plugin", async () => {
    const many = Array.from({ length: 6 }, (_, i) => series(`s${i}`));
    expect(await drawn([ext("money", async (c) => (isCurrent(c) ? many : []))])).toEqual(["money/dashboard-revenue/s0", "money/dashboard-revenue/s1", "money/dashboard-revenue/s2", "money/dashboard-revenue/s3"]);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("one plugin failing does not take the others down", () => {
  const healthy = () => ext("healthy", async (c) => [series("ok", { href: "/admin/ext/healthy", days: { [c.to]: 1 } })]);

  it.each([
    ["throws synchronously", () => { throw new Error("boom"); }, "failed; skipped"],
    ["rejects", async () => { throw new Error("boom"); }, "failed; skipped"],
    ["answers with something that is not a list", async () => ({ id: "x" }), "failed; skipped"],
    ["answers with nothing", async () => undefined, "failed; skipped"],
  ])("a plugin that %s draws nothing, with a log line for each period asked", async (_label, load, message) => {
    expect(await drawn([ext("broken", load as unknown as Extension["dashboardRevenue"]), healthy()])).toEqual(["healthy/dashboard-revenue/ok"]);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[0][0])).toContain(`[dashboard-widgets] ext="broken" dashboardRevenue ${message}`);
  });

  it("a plugin that takes too long is skipped at the time limit", async () => {
    const started = Date.now();
    const slow = ext("slow", () => new Promise((resolve) => setTimeout(() => resolve([series("late")]), 400)));
    expect(await drawn([slow, healthy()], { timeoutMs: 50 })).toEqual(["healthy/dashboard-revenue/ok"]);
    expect(Date.now() - started).toBeLessThan(350);
    expect(String(errors.mock.calls[0][0])).toContain('ext="slow" dashboardRevenue took longer than 50ms');
  });
});

describe("who sees which series", () => {
  it("a custom role sees only the series whose page it can open, without a log line", async () => {
    const money = ext("money", async (c) => [series("own", { href: "/admin/ext/money?range=30", days: {} }), series("elsewhere", { href: "/admin/ext/other", days: { [c.to]: 1 } })]);
    const viewer = dashboardViewer({ "/admin/ext/money": "view" })!;
    expect(await drawn([money], { canOpen: viewer.canOpen })).toEqual(["money/dashboard-revenue/own"]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("comparing with the previous period", () => {
  it("asks for this and the previous period and adds them up", async () => {
    const asked: string[] = [];
    const money = ext("money", async (c) => {
      asked.push(`${c.from}..${c.to}`);
      return [series("orders", { days: { [c.to]: isCurrent(c) ? 300 : 200 } })];
    });
    const { cards, period } = await loadDashboardWidgets([money], opts());
    expect(asked.sort()).toEqual(["2026-09-10..2026-09-16", "2026-09-17..2026-09-23"]);
    expect(cards[0].previous).toBe(200);
    expect(period).toMatchObject({ preset: 7, from: "2026-09-17", to: "2026-09-23" });
  });

  it("does not compare when a series is missing from the previous period", async () => {
    const money = ext("money", async (c) => {
      if (!isCurrent(c)) throw new Error("previous failed");
      return [series("orders")];
    });
    const { cards } = await loadDashboardWidgets([money], opts());
    expect(cards[0].previous).toBeNull();
  });

  it("draws nothing when no plugin has revenue or the viewer can open none of it", async () => {
    expect((await loadDashboardWidgets([ext("plain", undefined)], opts())).cards).toEqual([]);
    expect((await loadDashboardWidgets([ext("money", async () => [])], opts())).cards).toEqual([]);
    const hidden = ext("money", async () => [series("orders", { href: "/admin/ext/money" })]);
    expect((await loadDashboardWidgets([hidden], opts({ canOpen: () => false }))).cards).toEqual([]);
  });
});

describe("the revenue card on the dashboard looks as in 1.61.0", () => {
  const renderPage = async (searchParams: Record<string, string> = {}) => {
    const element = (await DashboardPage({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
    return renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, element));
  };
  /** 這一段的最後一天 1,500,前一段 1,000(不管期間多長)。 */
  const money = () =>
    ext("money", async (c) => [
      series("orders", {
        label: { en: "Shop orders", "zh-Hant": "商城訂單" },
        href: `/admin/ext/money/report?range=30`,
        days: { [c.to]: isCurrent(c) ? 1500 : 1000 },
      }),
    ]);

  it("shows the total, the change against the previous period and a legend linking to the series", { timeout: 30_000 }, async () => {
    state.exts = [money()];
    const html = await renderPage();
    expect(html).toContain("營業額");
    expect(html).toContain("NT$ 1,500");
    expect(html).toContain("50%");
    expect(html).toContain("比前 30 天");
    expect(html).toContain("商城訂單");
    expect(html).toContain('href="/admin/ext/money/report?range=30"');
    // 期間控制:30 天那一段按下去的樣子,整頁只有一個。
    expect(html.match(/aria-pressed="true"[^>]*>30 天</g)).toHaveLength(1);
    expect(html).not.toContain("這段期間沒有營業額");
  });

  it("follows the period in the URL", { timeout: 30_000 }, async () => {
    const seen: string[] = [];
    state.exts = [ext("money", async (c) => ((seen.push(c.from), [series("orders", { href: "/admin/ext/money", days: { [c.to]: 1 } })])))];
    const html = await renderPage({ range: "7" });
    expect(html).toMatch(/aria-pressed="true"[^>]*>7 天</);
    expect(html).toContain("比前 7 天");
    expect(new Set(seen).size).toBe(2);
  });

  it("keeps the chart and says so in one line when the period has no revenue", { timeout: 30_000 }, async () => {
    state.exts = [ext("money", async () => [series("orders", { href: "/admin/ext/money", days: {} })])];
    const html = await renderPage();
    expect(html).toContain("營業額");
    expect(html).toContain("NT$ 0");
    expect(html).toContain("這段期間沒有營業額。");
    // 兩段都是 0:沒有比較。
    expect(html).not.toContain("比前 30 天");
  });

  it("is not drawn without revenue, or when the viewer can open none of it", { timeout: 30_000 }, async () => {
    state.exts = [ext("plain", undefined)];
    expect(await renderPage()).not.toContain("營業額");
    state.exts = [money()];
    state.access = { "/admin/ext/other": "view" };
    expect(await renderPage()).not.toContain("營業額");
  });

  it("sits after the plugin's number cards", { timeout: 30_000 }, async () => {
    state.exts = [
      {
        ...money(),
        dashboardStats: async () => [{ id: "today", title: "今日訂單", href: "/admin/ext/money", value: 3, display: "3 筆" }],
      },
    ];
    const html = await renderPage();
    expect(html.indexOf("今日訂單")).toBeGreaterThan(-1);
    expect(html.indexOf("dashboard-plugin-chart-0")).toBeGreaterThan(html.indexOf("今日訂單"));
  });

  it("stacks on the same card with a plugin that moved to dashboardWidgets", { timeout: 30_000 }, async () => {
    const modern: Extension = {
      id: "modern",
      name: "modern",
      version: "1.0.0",
      coreApi: "^1.62.0",
      metrics: [REVENUE],
      dashboardWidgets: [
        {
          id: "sales",
          kind: "timeseries",
          metric: REVENUE.key,
          period: true,
          load: async (ctx) => ({
            kind: "timeseries",
            bucket: "day",
            series: [{ id: "sales", label: "新插件", href: "/admin/ext/modern", points: { [ctx.period!.to]: isCurrent({ end: ctx.period!.end, now: ctx.now }) ? 500 : 0 } }],
          }),
        },
      ],
    };
    state.exts = [money(), modern];
    const html = await renderPage();
    expect(html.match(/>營業額<\/h3>/g)).toHaveLength(1);
    expect(html).toContain("NT$ 2,000");
    expect(html).toContain("100%");
    expect(html).toContain("新插件");
    expect(html).toContain("商城訂單");
  });
});
