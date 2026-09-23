import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 1.52.0:儀表板照角色的授權顯示。自訂角色只看得到它打得開的頁的卡片與數字,「新增」要那一頁
// 的編輯;成員數、資料庫用量只有管理者,儲存空間跟著媒體庫。預設角色(沒有 access)照舊全部。

const state = vi.hoisted(() => ({
  access: null as Record<string, "view" | "edit"> | null,
  types: [] as unknown[],
  calls: { activity: [] as unknown[][], storage: 0, database: 0, cards: [] as unknown[] },
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
vi.mock("@/ext/dx/type-directory", () => ({ listDeclarativeTypes: async () => state.types }));
vi.mock("@/ext/loader", () => ({ getExtRuntime: async () => ({ enabled: [] }) }));
vi.mock("@/lib/i18n/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/i18n/server")>();
  return { ...actual, getLocale: async () => "zh-Hant" };
});
// 儀表板頁用到的其餘依賴:session 由測試決定;守門、設定、時區不在這裡測。
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth")>()),
  getSessionAccess: async () => ({ user: { id: "u1", role: "admin" }, access: state.access }),
}));
vi.mock("@/lib/access-guards", () => ({ guardDashboard: async () => {} }));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/datetime-server", () => ({ getSiteTimeZone: async () => "Asia/Taipei" }));
// 記下頁面怎麼呼叫(活躍度算哪些類型、有沒有查儲存空間與資料庫、卡片有沒有 canOpen);
// 活躍度與卡片照樣走真的實作。
vi.mock("@/components/admin/dashboard/widget-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/admin/dashboard/widget-data")>();
  return {
    ...actual,
    getWeeklyActivity: (...args: Parameters<typeof actual.getWeeklyActivity>) => {
      state.calls.activity.push(args);
      return actual.getWeeklyActivity(...args);
    },
    getStorageStats: async () => {
      state.calls.storage++;
      return { fileCount: 0, totalBytes: 0, truncated: false };
    },
    getDatabaseStats: async () => {
      state.calls.database++;
      return { bytes: 0 };
    },
  };
});
vi.mock("@/ext/dx/dashboard-cards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ext/dx/dashboard-cards")>();
  return {
    ...actual,
    resolveDashboardCards: (...args: Parameters<typeof actual.resolveDashboardCards>) => {
      state.calls.cards.push(args[2]);
      return actual.resolveDashboardCards(...args);
    },
  };
});

import { dashboardViewer, dashboardViewerFor } from "../src/components/admin/dashboard/viewer";
import { resolveDashboardCards } from "../src/ext/dx/dashboard-cards";
import { getWeeklyActivity } from "../src/components/admin/dashboard/widget-data";
import DashboardPage from "../src/app/(admin)/admin/page";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n";
import type { Extension } from "../src/ext/types";
import type { DeclarativeContentType } from "../src/ext/dx/manifest";

const d1 = () => (env as { DB: D1Database }).DB;
const DAY = 86_400_000;

const productType: DeclarativeContentType = { name: "product", label: "商品", fields: [{ key: "name", type: "text" }] };
const categoryType: DeclarativeContentType = { name: "category", label: "分類", fields: [{ key: "name", type: "text" }] };
const typeInfo = (name: "product" | "category", href: string) => ({
  typeKey: `permcat.${name}`,
  typeLabel: name,
  extId: "permcat",
  extName: "目錄",
  contentType: name === "product" ? productType : categoryType,
  collectionHref: href,
  newHref: `${href}/edit`,
});

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS contents (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'en', translation_group TEXT NOT NULL DEFAULT '', slug TEXT, status TEXT DEFAULT 'draft' NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, avatar_key TEXT, staff_role_id TEXT);",
  );
  await d1().exec(
    "INSERT OR REPLACE INTO users (id, email, password_hash, name, role, created_at) VALUES ('perm-u1', 'perm-u1@test.com', 'x', 'perm', 'admin', 1);",
  );
  const insert = (id: string, type: string, status: string, at: number) =>
    d1()
      .prepare("INSERT OR REPLACE INTO contents (id, type, slug, status, data, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)")
      .bind(id, type, status, JSON.stringify({ name: id }), at, at)
      .run();
  // 商品三筆(兩筆已發佈)、分類一筆;都在「最近 14 天」裡。
  await insert("perm-p1", "permcat.product", "published", 20 * DAY);
  await insert("perm-p2", "permcat.product", "published", 21 * DAY);
  await insert("perm-p3", "permcat.product", "draft", 22 * DAY);
  await insert("perm-c1", "permcat.category", "published", 23 * DAY);
});

beforeEach(() => {
  state.types = [typeInfo("product", "/admin/ext/permcat"), typeInfo("category", "/admin/ext/permcat/categories")];
});

describe("dashboardViewer", () => {
  it("預設角色(沒有 access):null,照舊全部顯示", () => {
    expect(dashboardViewer(null)).toBeNull();
  });

  it("管理員照舊全部顯示;工作人員只打得開儀表板,卡片與數字都濾掉;自訂角色照它的 access", () => {
    expect(dashboardViewerFor(null)).toBeNull();
    expect(dashboardViewerFor({ user: { role: "admin" }, access: null })).toBeNull();
    const staff = dashboardViewerFor({ user: { role: "editor" }, access: null })!;
    expect(staff.canOpen("/admin/ext/shop")).toBe(false);
    expect(staff.canOpen("/admin/ext/permcat")).toBe(false);
    expect(staff.users).toBe(false);
    const custom = dashboardViewerFor({ user: { role: "editor" }, access: { "/admin/ext/permcat": "view" } })!;
    expect(custom.canOpen("/admin/ext/permcat")).toBe(true);
  });

  it("自訂角色:打得開 = 檢視以上,新增 = 編輯;成員數與資料庫用量不給;儲存空間跟著媒體庫", () => {
    const viewer = dashboardViewer({ "/admin/ext/permcat": "edit", "/admin/ext/permcat/categories": "view" })!;
    expect(viewer.canOpen("/admin/ext/permcat")).toBe(true);
    expect(viewer.canCreate("/admin/ext/permcat")).toBe(true);
    expect(viewer.canOpen("/admin/ext/permcat/categories/")).toBe(true);
    expect(viewer.canCreate("/admin/ext/permcat/categories")).toBe(false);
    expect(viewer.canOpen("/admin/ext/other?status=1")).toBe(false);
    expect(viewer.canOpen("/admin/users")).toBe(false);
    expect([viewer.users, viewer.database, viewer.storage]).toEqual([false, false, false]);
    expect(dashboardViewer({ "/admin/media": "view" })!.storage).toBe(true);
  });
});

describe("getDashboardData", () => {
  const load = async (access: Record<string, "view" | "edit"> | null) => {
    const { getDashboardData } = await import("../src/components/admin/dashboard/aggregate");
    return getDashboardData(dashboardViewer(access));
  };

  it("預設角色:全部類型、全部數字、成員數,都能新增", async () => {
    const data = await load(null);
    expect(data.types.map((t) => t.typeKey)).toEqual(["permcat.product", "permcat.category"]);
    expect(data.types.every((t) => t.canCreate)).toBe(true);
    expect(data.totalEntries).toBe(4);
    expect(data.recent.map((r) => r.id)).toContain("perm-c1");
    expect(data.userCount).toBeGreaterThan(0);
  });

  it("自訂角色只打得開分類頁(檢視):卡片、最近更新、總數都只有分類,不能新增", async () => {
    const data = await load({ "/admin/ext/permcat/categories": "view" });
    expect(data.types.map((t) => t.typeKey)).toEqual(["permcat.category"]);
    expect(data.types[0].canCreate).toBe(false);
    expect([data.totalEntries, data.totalPublished, data.typeCount]).toEqual([1, 1, 1]);
    expect(data.recent.map((r) => r.id)).toEqual(["perm-c1"]);
    expect(data.userCount).toBe(0);
    // 插件卡片要找類型的列表頁:看不到的類型也在表裡。
    expect(data.collectionHrefs).toEqual({
      "permcat.product": "/admin/ext/permcat",
      "permcat.category": "/admin/ext/permcat/categories",
    });
  });

  it("自訂角色什麼類型都打不開:沒有類型、數字是 0", async () => {
    const data = await load({ "/admin": "view" });
    expect(data.hasTypes).toBe(false);
    expect(data.totalEntries).toBe(0);
    expect(data.recent).toEqual([]);
  });
});

describe("插件的儀表板卡", () => {
  const ext = (id: string, cards: Extension["dashboardCards"]): Extension => ({
    id,
    name: id,
    version: "1.0.0",
    coreApi: "^1.6.0",
    contentTypes: [productType, categoryType],
    dashboardCards: cards,
  });
  const cards: Extension["dashboardCards"] = [
    { kind: "stat", contentType: "product" },
    { kind: "recent", contentType: "category", limit: 3 },
  ];
  const hrefs = { "permcat.product": "/admin/ext/permcat", "permcat.category": "/admin/ext/permcat/categories" };

  it("連到列出那個類型的頁,編輯連結也在那一頁底下", async () => {
    const out = await resolveDashboardCards([ext("permcat", cards)], "zh-Hant", { hrefs });
    expect(out.map((c) => c.adminHref)).toEqual(["/admin/ext/permcat", "/admin/ext/permcat/categories"]);
    expect(out[0].count).toBe(3);
    expect(out[1].entries?.[0].editHref).toBe("/admin/ext/permcat/categories/edit?id=perm-c1");
  });

  it("自訂角色:來源頁打不開的卡不顯示", async () => {
    const viewer = dashboardViewer({ "/admin/ext/permcat/categories": "view" })!;
    const out = await resolveDashboardCards([ext("permcat", cards)], "zh-Hant", { hrefs, canOpen: viewer.canOpen });
    expect(out.map((c) => c.contentType)).toEqual(["permcat.category"]);
  });

  it("code extension 自己宣告的卡(不在類型目錄裡):跟著插件主頁", async () => {
    const code = ext("permcode", [{ kind: "stat", contentType: "product" }]);
    const none = dashboardViewer({ "/admin/ext/permcat": "edit" })!;
    expect(await resolveDashboardCards([code], "zh-Hant", { hrefs, canOpen: none.canOpen })).toEqual([]);
    const root = dashboardViewer({ "/admin/ext/permcode": "view" })!;
    const out = await resolveDashboardCards([code], "zh-Hant", { hrefs, canOpen: root.canOpen });
    expect(out.map((c) => c.adminHref)).toEqual(["/admin/ext/permcode"]);
  });
});

describe("兩週活躍度", () => {
  it("給了類型就只算那些類型;空清單不查", async () => {
    const now = 30 * DAY;
    expect((await getWeeklyActivity(now, ["permcat.category"])).value).toBe(1);
    expect((await getWeeklyActivity(now, ["permcat.product", "permcat.category"])).value).toBe(4);
    expect((await getWeeklyActivity(now, [])).value).toBe(0);
    // 省略 = 全部(其他測試檔也可能寫進 contents,所以只比「至少」)。
    expect((await getWeeklyActivity(now)).value as number).toBeGreaterThanOrEqual(4);
  });
});

// ---- 儀表板頁本身:哪些東西照 viewer 顯示 ----

describe("儀表板頁", () => {
  const render = async (access: Record<string, "view" | "edit"> | null) => {
    state.access = access;
    state.calls = { activity: [], storage: 0, database: 0, cards: [] };
    const element = (await DashboardPage()) as ReactElement;
    return renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-Hant", messages: getMessages("zh-Hant") }, element));
  };

  it("預設角色:成員數、儲存空間與資料庫用量都在,活躍度算全部", { timeout: 30_000 }, async () => {
    const out = await render(null);
    expect(out).toContain("成員");
    expect(state.calls.storage + state.calls.database).toBe(2);
    expect(state.calls.activity[0]?.[1]).toBeUndefined();
    expect((state.calls.cards[0] as { canOpen?: unknown }).canOpen).toBeUndefined();
  });

  it("自訂角色:沒有成員數與資料庫用量,儲存空間要媒體庫,活躍度只算看得到的類型", { timeout: 30_000 }, async () => {
    const out = await render({ "/admin/ext/permcat/categories": "view" });
    expect(out).not.toContain("成員");
    expect(state.calls.database).toBe(0);
    expect(state.calls.storage).toBe(0);
    expect(state.calls.activity[0]?.[1]).toEqual(["permcat.category"]);
    expect(typeof (state.calls.cards[0] as { canOpen?: unknown }).canOpen).toBe("function");
    await render({ "/admin/ext/permcat/categories": "view", "/admin/media": "view" });
    expect(state.calls.storage).toBe(1);
  });

  it("自訂角色什麼都看不到:說一句找管理者,不給擴充功能的入口", { timeout: 30_000 }, async () => {
    const out = await render({ "/admin": "view" });
    expect(out).toContain("你的角色目前看不到這裡的內容。");
    expect(out).not.toContain('href="/admin/extensions"');
  });
});
