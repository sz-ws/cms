import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.52.0:code extension 自己的儀表板數字(Extension.dashboardStats)。core 收集、驗證、隔離
// 失敗與逾時、照 viewer 的 canOpen 過濾,再用內容類型數字卡的樣子畫出來;連結文字走 i18n。

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
  default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children),
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
// 站台時區不是預設的台北:證明頁面把 getSiteTimeZone 的值交給插件。
vi.mock("@/lib/datetime-server", () => ({ getSiteTimeZone: async () => "America/New_York" }));
// NumberFlow 在伺服器上畫不出數字(client 元件);換成照 locales 用 Intl 格式化的 span,
// 驗的是卡片把語系交給 StatNumber —— 格式化本身是 NumberFlow 用同一個 locales 做的。
vi.mock("@/components/admin/StatNumber", () => ({
  StatNumber: ({ value, locales }: { value: number; locales?: Intl.LocalesArgument }) =>
    createElement("span", null, new Intl.NumberFormat(locales).format(value)),
}));

import { resolveDashboardCards } from "../src/ext/dx/dashboard-cards";
import { DASHBOARD_STATS_TIMEOUT_MS, normalizeStat } from "../src/ext/dx/dashboard-stats";
import { dashboardViewer } from "../src/components/admin/dashboard/viewer";
import { ExtStatCard } from "../src/components/admin/dashboard/ExtStatCard";
import DashboardPage from "../src/app/(admin)/admin/page";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages, type Locale } from "../src/lib/i18n";
import { defineExtension, type DashboardStat, type DashboardStatsContext, type Extension } from "../src/ext/types";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";

const d1 = () => (env as { DB: D1Database }).DB;
const NOW = Date.UTC(2026, 8, 23, 4, 0);
const noteType: DeclarativeContentType = { name: "note", label: "Notes", fields: [{ key: "body", type: "text" }] };

const stat = (id: string, extra: Partial<DashboardStat> = {}): DashboardStat => ({
  id,
  title: `Title ${id}`,
  href: `/admin/ext/numbers/${id}`,
  value: 1,
  ...extra,
});
const ext = (id: string, load: Extension["dashboardStats"], more: Partial<Extension> = {}): Extension => ({
  id,
  name: { en: `${id} plugin`, "zh-Hant": `${id} 插件` },
  version: "1.0.0",
  coreApi: "^1.52.0",
  dashboardStats: load,
  ...more,
});
const ids = (cards: { statId?: string }[]) => cards.map((c) => c.statId);

let errors: MockInstance<typeof console.error>;
beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT DEFAULT 'draft' NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "INSERT OR REPLACE INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES ('numbers-n1', 'numbers.note', NULL, 'published', '{\"body\":\"x\"}', 1, 1);",
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

describe("collecting a plugin's numbers", () => {
  it("calls dashboardStats with now, the site time zone, the locale and canOpen, and makes stat cards", async () => {
    let seen: DashboardStatsContext | undefined;
    const numbers = ext("numbers", async (ctx) => {
      seen = ctx;
      return [
        stat("orders", { title: { en: "Orders today", "zh-Hant": "今日訂單" }, href: "/admin/ext/numbers?from=1&to=2", value: 12 }),
        stat("money", { value: 1200, display: "NT$ 1,200", hint: { en: "Since midnight", "zh-Hant": "今天 00:00 起" } }),
      ];
    });
    const cards = await resolveDashboardCards([numbers], "zh-Hant", { now: NOW, timeZone: "Europe/London" });
    expect(seen).toMatchObject({ now: NOW, timeZone: "Europe/London", locale: "zh-Hant" });
    expect(seen?.canOpen("/admin/ext/anything")).toBe(true);
    expect(cards).toEqual([
      { extId: "numbers", extName: "numbers 插件", kind: "stat", title: "今日訂單", statId: "orders", adminHref: "/admin/ext/numbers?from=1&to=2", count: 12 },
      { extId: "numbers", extName: "numbers 插件", kind: "stat", title: "Title money", statId: "money", adminHref: "/admin/ext/numbers/money", count: 1200, display: "NT$ 1,200", hint: "今天 00:00 起" },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("falls back to Taipei and the current time when the caller gives neither", async () => {
    let seen: DashboardStatsContext | undefined;
    const before = Date.now();
    await resolveDashboardCards([ext("numbers", async (ctx) => ((seen = ctx), []))], "en", { timeZone: "Not/AZone" });
    expect(seen?.timeZone).toBe("Asia/Taipei");
    expect(seen?.now).toBeGreaterThanOrEqual(before);
  });

  it("puts a plugin's numbers after its content cards, in extension order", async () => {
    const a = ext("numbers", async () => [stat("a1")], {
      contentTypes: [noteType],
      dashboardCards: [{ kind: "stat", contentType: "note" }],
    });
    const b = ext("other", async () => [stat("b1", { href: "/admin/ext/other" })]);
    const cards = await resolveDashboardCards([a, b], "en");
    expect(cards.map((c) => c.contentType ?? c.statId)).toEqual(["numbers.note", "a1", "b1"]);
    expect(cards[0].count).toBe(1);
  });

  it("gives each plugin its own ctx", async () => {
    const meddler = ext("meddler", async (ctx) => {
      (ctx as { timeZone: string }).timeZone = "UTC";
      return [];
    });
    let seen: string | undefined;
    const reader = ext("reader", async (ctx) => ((seen = ctx.timeZone), []));
    await resolveDashboardCards([meddler, reader], "en", { timeZone: "Asia/Tokyo" });
    expect(seen).toBe("Asia/Tokyo");
  });

  it("defineExtension accepts the hook and refuses a non-function", () => {
    expect(() => defineExtension(ext("numbers", async () => []))).not.toThrow();
    expect(() => defineExtension({ ...ext("numbers", undefined), dashboardStats: "nope" } as unknown as Extension)).toThrow(/dashboardStats/);
  });
});

describe("entries that break the rules", () => {
  it("drops each bad entry with a log line and keeps the rest", async () => {
    const entries: unknown[] = [
      stat("good"),
      null,
      "text",
      [],
      stat("Bad_Id"),
      { ...stat("no-title"), title: "   " },
      { ...stat("long-title"), title: "x".repeat(61) },
      { ...stat("bad-title"), title: 5 },
      stat("external", { href: "https://example.com/admin" }),
      stat("protocol-relative", { href: "//example.com/admin" }),
      stat("outside", { href: "/account" }),
      stat("dots", { href: "/admin/../account" }),
      stat("space", { href: "/admin/ext/x y" }),
      stat("upper", { href: "/admin/Ext" }),
      stat("nan", { value: Number.NaN }),
      stat("infinite", { value: Number.POSITIVE_INFINITY }),
      { ...stat("string-value"), value: "3" },
      { ...stat("display-number"), display: 3 },
      stat("long-display", { display: "x".repeat(25) }),
      stat("control", { display: "a\u0007b" }),
      stat("long-hint", { hint: "x".repeat(81) }),
      stat("good"),
      stat("negative", { value: -2.5, display: "  ", hint: "" }),
    ];
    const cards = await resolveDashboardCards([ext("numbers", async () => entries as DashboardStat[])], "en");
    expect(ids(cards)).toEqual(["good", "negative"]);
    // 空白的 display / hint 當作沒給:數字照語系格式化,小字是插件名稱。
    expect(cards[1]).not.toHaveProperty("display");
    expect(cards[1]).not.toHaveProperty("hint");
    expect(cards[1].count).toBe(-2.5);
    expect(errors).toHaveBeenCalledTimes(entries.length - 2);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stats[1] is not an object'),
        expect.stringContaining('"external" href must be an admin path'),
        expect.stringContaining('"nan" value must be a finite number'),
        expect.stringContaining('"long-display" display must be text of at most 24'),
        expect.stringContaining('stats[21] repeats id "good"'),
      ]),
    );
  });

  it("keeps an href's query and trims the text", () => {
    expect(normalizeStat({ id: "a", title: "  Orders ", href: "/admin/ext/shop?from=1&to=2&q=%E5", value: 0, display: " 0 筆 " }, "en")).toEqual({
      id: "a",
      title: "Orders",
      href: "/admin/ext/shop?from=1&to=2&q=%E5",
      value: 0,
      display: "0 筆",
    });
    expect(normalizeStat({ id: "a", title: "x", href: "/admin", value: 0 }, "en")).toMatchObject({ href: "/admin" });
    expect(normalizeStat({ id: "a", title: "x", href: "/admin/ext/shop#top", value: 0 }, "en")).toEqual(expect.any(String));
  });

  it("shows at most twelve numbers per plugin", async () => {
    const many = Array.from({ length: 14 }, (_, i) => stat(`n${i}`));
    const cards = await resolveDashboardCards([ext("numbers", async () => many)], "en");
    expect(ids(cards)).toEqual(many.slice(0, 12).map((s) => s.id));
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("one plugin failing does not take the others down", () => {
  const healthy = () => ext("healthy", async () => [stat("ok", { href: "/admin/ext/healthy" })]);

  it.each([
    ["throws synchronously", () => { throw new Error("boom"); }],
    ["rejects", async () => { throw new Error("boom"); }],
    ["answers with something that is not a list", async () => ({ id: "x" })],
    ["answers with nothing", async () => undefined],
  ])("a plugin that %s shows nothing, with one log line", async (_label, load) => {
    const cards = await resolveDashboardCards([ext("broken", load as unknown as Extension["dashboardStats"]), healthy()], "en");
    expect(ids(cards)).toEqual(["ok"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('ext="broken"');
  });

  it("a plugin that takes too long is skipped at the time limit", async () => {
    const started = Date.now();
    let late = false;
    const slow = ext("slow", () => new Promise((resolve) => setTimeout(() => ((late = true), resolve([stat("late")])), 400)));
    const cards = await resolveDashboardCards([slow, healthy()], "en", { statsTimeoutMs: 50 });
    expect(ids(cards)).toEqual(["ok"]);
    expect(Date.now() - started).toBeLessThan(350);
    expect(late).toBe(false);
    expect(String(errors.mock.calls[0][0])).toContain('ext="slow" dashboardStats took longer than 50ms');
  });

  it("a plugin that never answers is skipped too, and a late rejection is harmless", async () => {
    const never = ext("never", () => new Promise(() => {}));
    const lateReject = ext("late-reject", () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 80)));
    const cards = await resolveDashboardCards([never, lateReject, healthy()], "en", { statsTimeoutMs: 30 });
    expect(ids(cards)).toEqual(["ok"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("the default time limit is short", () => {
    expect(DASHBOARD_STATS_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

describe("who sees which number", () => {
  const numbers = () =>
    ext("numbers", async () => [
      stat("own", { href: "/admin/ext/numbers?from=1" }),
      stat("sub", { href: "/admin/ext/numbers/payments" }),
      stat("elsewhere", { href: "/admin/ext/other" }),
      stat("media", { href: "/admin/media" }),
    ]);

  it("a custom role sees only the numbers whose page it can open, and the plugin gets the same canOpen", async () => {
    const viewer = dashboardViewer({ "/admin/ext/numbers": "view", "/admin/media": "view" })!;
    let pluginCanOpen: ((href: string) => boolean) | undefined;
    const withSpy = ext("numbers", async (ctx) => {
      pluginCanOpen = ctx.canOpen;
      return (await numbers().dashboardStats!(ctx));
    });
    const cards = await resolveDashboardCards([withSpy], "zh-Hant", { canOpen: viewer.canOpen });
    expect(ids(cards)).toEqual(["own", "media"]);
    expect(pluginCanOpen?.("/admin/ext/other")).toBe(false);
    // 打不開不是插件的錯,不記 log。
    expect(errors).not.toHaveBeenCalled();
    const none = dashboardViewer({ "/admin/ext/unrelated": "edit" })!;
    expect(await resolveDashboardCards([numbers()], "zh-Hant", { canOpen: none.canOpen })).toEqual([]);
  });

  it("presets (no access map) still see every number", async () => {
    expect(dashboardViewer(null)).toBeNull();
    const cards = await resolveDashboardCards([numbers()], "zh-Hant", { canOpen: undefined });
    expect(ids(cards)).toEqual(["own", "sub", "elsewhere", "media"]);
  });
});

describe("the stat tile", () => {
  const render = (card: Parameters<typeof ExtStatCard>[0]["card"], locale: Locale) =>
    renderToStaticMarkup(
      createElement(ExtStatCard, { card, locale, labels: { view: getMessages(locale)["dashboard.extStat.view"] } }),
    );
  const base = { extId: "numbers", extName: "數字插件", kind: "stat" as const, title: "點數使用量", adminHref: "/admin/ext/numbers" };

  it("shows the plugin's display string instead of the number, and its hint instead of the extension name", () => {
    const html = render({ ...base, statId: "points", count: 35000, display: "3.5 點", hint: "今天確認扣掉的" }, "zh-Hant");
    expect(html).toContain("3.5 點");
    expect(html).not.toContain("35,000");
    expect(html).toContain("今天確認扣掉的");
    expect(html).not.toContain("數字插件");
    expect(html).toContain('href="/admin/ext/numbers"');
  });

  it("formats the number for the admin locale when there is no display", () => {
    const html = render({ ...base, statId: "count", count: 12345.5 }, "en");
    expect(html).toContain("12,345.5");
    expect(html).toContain("數字插件");
    const de = renderToStaticMarkup(
      createElement(ExtStatCard, { card: { ...base, count: 12345.5 }, locale: "de-DE" as Locale, labels: { view: "x" } }),
    );
    expect(de).toContain("12.345,5");
  });

  it("the link reads 查看 in Chinese and View in English, never the old hard-coded text", () => {
    const zh = render({ ...base, contentType: "numbers.note", count: 1 }, "zh-Hant");
    const en = render({ ...base, contentType: "numbers.note", count: 1 }, "en");
    expect(getMessages("zh-Hant")["dashboard.extStat.view"]).toBe("查看");
    expect(getMessages("en")["dashboard.extStat.view"]).toBe("View");
    expect(zh).toContain("查看");
    expect(en).toContain("View");
    expect(zh + en).not.toContain("View all");
  });
});

describe("the dashboard page", () => {
  const renderPage = async () => {
    const element = (await DashboardPage()) as ReactElement;
    return renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, element));
  };

  it("draws a plugin's numbers with the site time zone, and a custom role only those it can open", { timeout: 30_000 }, async () => {
    let seen: DashboardStatsContext | undefined;
    state.exts = [
      ext("numbers", async (ctx) => {
        seen = ctx;
        return [
          stat("orders", { title: "今日一般訂單", href: "/admin/ext/numbers", value: 3, display: "3 筆" }),
          stat("commission", { title: "佣金", href: "/admin/ext/other", value: 51, display: "NT$ 51" }),
        ];
      }),
      ext("broken", async () => {
        throw new Error("boom");
      }),
    ];
    const html = await renderPage();
    expect(seen?.timeZone).toBe("America/New_York");
    expect(seen?.locale).toBe("zh-Hant");
    expect(html).toContain("今日一般訂單");
    expect(html).toContain("3 筆");
    expect(html).toContain("NT$ 51");
    expect(html).toContain("查看");

    state.access = { "/admin/ext/numbers": "view" };
    const limited = await renderPage();
    expect(limited).toContain("3 筆");
    expect(limited).not.toContain("NT$ 51");
  });
});
