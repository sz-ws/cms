import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.61.0:插件的每日營業額(Extension.dashboardRevenue)。core 收集、驗證、隔離失敗與逾時、照
// viewer 的 canOpen 過濾,儀表板畫成營業額卡(期間控制、合計、比前一段、疊加長條圖)。

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

import {
  DASHBOARD_REVENUE_TIMEOUT_MS,
  normalizeRevenueSeries,
  resolveDashboardRevenue,
} from "../src/ext/dx/dashboard-revenue";
import { loadDashboardRevenue } from "../src/components/admin/dashboard/revenue-data";
import { dashboardViewer } from "../src/components/admin/dashboard/viewer";
import DashboardPage from "../src/app/(admin)/admin/page";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import {
  defineExtension,
  type DashboardRevenueContext,
  type Extension,
  type RevenueSeries,
} from "../src/ext/types";

const d1 = () => (env as { DB: D1Database }).DB;
const NOW = Date.UTC(2026, 8, 23, 4, 0); // 台北 9/23 12:00
const ctx = (extra: Partial<DashboardRevenueContext> = {}): DashboardRevenueContext => ({
  now: NOW,
  timeZone: "Asia/Taipei",
  locale: "zh-Hant",
  canOpen: () => true,
  from: "2026-09-17",
  to: "2026-09-23",
  start: Date.UTC(2026, 8, 16, 16),
  end: Date.UTC(2026, 8, 23, 16),
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
const keys = (list: { key: string }[]) => list.map((s) => s.key);

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

describe("collecting a plugin's revenue", () => {
  it("hands each plugin the period and keeps valid series, keyed by plugin", async () => {
    let seen: DashboardRevenueContext | undefined;
    const money = ext("money", async (c) => {
      seen = c;
      return [
        series("orders", { label: { en: "Orders", "zh-Hant": "訂單" }, href: "/admin/ext/money?range=7", days: { "2026-09-17": 10, "2026-09-23": 5.5 } }),
        series("zero", { days: {} }),
      ];
    });
    const other = ext("other", async () => [series("orders", { href: "/admin/ext/other" })]);
    const result = await resolveDashboardRevenue([money, other], ctx());
    expect(seen).toMatchObject({ from: "2026-09-17", to: "2026-09-23", start: Date.UTC(2026, 8, 16, 16), end: Date.UTC(2026, 8, 23, 16), timeZone: "Asia/Taipei", locale: "zh-Hant" });
    expect(result).toEqual([
      { extId: "money", key: "money/orders", id: "orders", label: "訂單", href: "/admin/ext/money?range=7", days: { "2026-09-17": 10, "2026-09-23": 5.5 } },
      { extId: "money", key: "money/zero", id: "zero", label: "Label zero", href: "/admin/ext/money/zero", days: {} },
      { extId: "other", key: "other/orders", id: "orders", label: "Label orders", href: "/admin/ext/other", days: { "2026-09-20": 100 } },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("gives each plugin its own ctx", async () => {
    const meddler = ext("meddler", async (c) => {
      (c as { from: string }).from = "2000-01-01";
      return [];
    });
    let seen: string | undefined;
    const reader = ext("reader", async (c) => ((seen = c.from), []));
    await resolveDashboardRevenue([meddler, reader], ctx());
    expect(seen).toBe("2026-09-17");
  });

  it("defineExtension accepts the hook and refuses a non-function", () => {
    expect(() => defineExtension(ext("money", async () => []))).not.toThrow();
    expect(() => defineExtension({ ...ext("money", undefined), dashboardRevenue: 5 } as unknown as Extension)).toThrow(/dashboardRevenue/);
  });
});

describe("series that break the rules", () => {
  it("drops the whole series for one bad day, and each bad series with a log line", async () => {
    const entries: unknown[] = [
      series("good"),
      null,
      [],
      series("Bad_Id"),
      { ...series("no-label"), label: "  " },
      series("long-label", { label: "x".repeat(41) }),
      series("external", { href: "https://example.com/admin" }),
      series("outside", { href: "/account" }),
      series("days-array", { days: [] as unknown as Record<string, number> }),
      series("days-null", { days: null as unknown as Record<string, number> }),
      series("before", { days: { "2026-09-16": 1, "2026-09-20": 5 } }),
      series("after", { days: { "2026-09-24": 1 } }),
      series("not-a-day", { days: { "2026-02-30": 1 } }),
      series("loose-day", { days: { "2026-9-20": 1 } }),
      series("negative", { days: { "2026-09-20": -1 } }),
      series("nan", { days: { "2026-09-20": Number.NaN } }),
      series("infinite", { days: { "2026-09-20": Number.POSITIVE_INFINITY } }),
      series("text", { days: { "2026-09-20": "5" as unknown as number } }),
      series("good"),
      series("zero-ok", { days: { "2026-09-20": 0 } }),
    ];
    const result = await resolveDashboardRevenue([ext("money", async () => entries as RevenueSeries[])], ctx());
    expect(keys(result)).toEqual(["money/good", "money/zero-ok"]);
    expect(errors).toHaveBeenCalledTimes(entries.length - 2);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[dashboard-revenue] ext="money" series[1] is not an object'),
        expect.stringContaining('"long-label" needs a label of at most 40'),
        expect.stringContaining('"external" href must be an admin path'),
        expect.stringContaining('"days-array" days must be an object'),
        expect.stringContaining('"before" day "2026-09-16" is not a date from 2026-09-17 to 2026-09-23'),
        expect.stringContaining('"negative" day "2026-09-20" must be a finite amount of at least 0'),
        expect.stringContaining('series[18] repeats id "good"'),
      ]),
    );
  });

  it("returns a clean copy of the days", () => {
    const days = { "2026-09-20": 7 };
    const normalized = normalizeRevenueSeries({ id: "a", label: " A ", href: "/admin", days, extra: 1 }, ctx());
    expect(normalized).toEqual({ id: "a", label: "A", href: "/admin", days: { "2026-09-20": 7 } });
    expect(typeof normalized !== "string" && normalized.days).not.toBe(days);
  });

  it("draws at most four series per plugin", async () => {
    const many = Array.from({ length: 6 }, (_, i) => series(`s${i}`));
    const result = await resolveDashboardRevenue([ext("money", async () => many)], ctx());
    expect(keys(result)).toEqual(["money/s0", "money/s1", "money/s2", "money/s3"]);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("one plugin failing does not take the others down", () => {
  const healthy = () => ext("healthy", async () => [series("ok", { href: "/admin/ext/healthy" })]);

  it.each([
    ["throws synchronously", () => { throw new Error("boom"); }],
    ["rejects", async () => { throw new Error("boom"); }],
    ["answers with something that is not a list", async () => ({ id: "x" })],
    ["answers with nothing", async () => undefined],
  ])("a plugin that %s draws nothing, with one log line", async (_label, load) => {
    const result = await resolveDashboardRevenue([ext("broken", load as unknown as Extension["dashboardRevenue"]), healthy()], ctx());
    expect(keys(result)).toEqual(["healthy/ok"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('[dashboard-revenue] ext="broken" dashboardRevenue');
  });

  it("a plugin that takes too long is skipped at the time limit", async () => {
    const started = Date.now();
    const slow = ext("slow", () => new Promise((resolve) => setTimeout(() => resolve([series("late")]), 400)));
    const result = await resolveDashboardRevenue([slow, healthy()], ctx(), 50);
    expect(keys(result)).toEqual(["healthy/ok"]);
    expect(Date.now() - started).toBeLessThan(350);
    expect(String(errors.mock.calls[0][0])).toContain('ext="slow" dashboardRevenue took longer than 50ms');
  });

  it("the default time limit is a few seconds", () => {
    expect(DASHBOARD_REVENUE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("who sees which series", () => {
  const money = () =>
    ext("money", async () => [
      series("own", { href: "/admin/ext/money?range=30" }),
      series("elsewhere", { href: "/admin/ext/other" }),
    ]);

  it("a custom role sees only the series whose page it can open, without a log line", async () => {
    const viewer = dashboardViewer({ "/admin/ext/money": "view" })!;
    const result = await resolveDashboardRevenue([money()], ctx({ canOpen: viewer.canOpen }));
    expect(keys(result)).toEqual(["money/own"]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("the dashboard's revenue data", () => {
  it("asks for this and the previous period and adds them up", async () => {
    const asked: string[] = [];
    const money = ext("money", async (c) => {
      asked.push(`${c.from}..${c.to}`);
      return [series("orders", { days: { [c.to]: c.from === "2026-09-17" ? 300 : 200 } })];
    });
    const data = await loadDashboardRevenue([money], { params: new URLSearchParams("range=7"), now: NOW, timeZone: "Asia/Taipei", locale: "zh-Hant" });
    expect(asked.sort()).toEqual(["2026-09-10..2026-09-16", "2026-09-17..2026-09-23"]);
    expect(data).toMatchObject({ total: 300, previousTotal: 200 });
    expect(data?.period).toMatchObject({ preset: 7, from: "2026-09-17", to: "2026-09-23" });
  });

  it("does not compare when a series is missing from the previous period", async () => {
    const money = ext("money", async (c) => {
      if (c.from !== "2026-09-17") throw new Error("previous failed");
      return [series("orders")];
    });
    const data = await loadDashboardRevenue([money], { params: new URLSearchParams("range=7"), now: NOW, timeZone: "Asia/Taipei", locale: "zh-Hant" });
    expect(data).toMatchObject({ total: 100, previousTotal: null });
  });

  it("is null when no plugin provides revenue or none can be opened", async () => {
    const opts = { params: new URLSearchParams(""), now: NOW, timeZone: "Asia/Taipei", locale: "zh-Hant" as const };
    expect(await loadDashboardRevenue([ext("plain", undefined)], opts)).toBeNull();
    expect(await loadDashboardRevenue([ext("money", async () => [])], opts)).toBeNull();
    const hidden = ext("money", async () => [series("orders", { href: "/admin/ext/money" })]);
    expect(await loadDashboardRevenue([hidden], { ...opts, canOpen: () => false })).toBeNull();
  });
});

describe("the revenue card on the dashboard", () => {
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
        days: { [c.to]: c.end > Date.now() ? 1500 : 1000 },
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
    // 期間控制:30 天那一段按下去的樣子。
    expect(html).toMatch(/aria-pressed="true"[^>]*>30 天</);
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
    expect(html.indexOf("dashboard-revenue-title")).toBeGreaterThan(html.indexOf("今日訂單"));
  });
});
