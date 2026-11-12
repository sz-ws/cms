import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 2.0:設定頁上一個按鈕「重新產生全部頁面」。店家在網站上看到舊的東西時(例如有人直接改了資料庫)按它,
// 呼叫的是每一筆寫入用的同一個函式 publicContentChanged。只有管理員能按。

const state = vi.hoisted(() => ({ user: null as null | { role: string }, reasons: [] as string[] }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/auth")>();
  return {
    ...actual,
    requireAuth: async (role?: string) => {
      if (!state.user) throw new actual.AuthError(401);
      if (role === "admin" && state.user.role !== "admin") throw new actual.AuthError(403);
      return state.user;
    },
  };
});
vi.mock("@/lib/public-cache", () => ({
  publicContentChanged: (reason: string) => {
    state.reasons.push(reason);
  },
}));

import { POST } from "../src/app/api/public-pages/refresh/route";
import { PublicPagesRefreshCard } from "../src/components/admin/PublicPagesRefreshCard";
import { I18nProvider } from "../src/lib/i18n/I18nProvider";
import { getMessages } from "../src/lib/i18n/index";

const post = (origin = "https://site.test") =>
  POST(new Request("https://site.test/api/public-pages/refresh", { method: "POST", headers: { origin } }));

beforeEach(() => {
  state.user = { role: "admin" };
  state.reasons = [];
});

describe("POST /api/public-pages/refresh", () => {
  it("an admin refreshes every stored public page with the same call every write uses", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.reasons).toEqual(["admin:refresh"]);
  });

  it("refuses other sites, signed-out visitors and non-admins", async () => {
    expect((await post("https://evil.test")).status).toBe(403);
    state.user = null;
    expect((await post()).status).toBe(401);
    state.user = { role: "editor" };
    expect((await post()).status).toBe(403);
    expect(state.reasons).toEqual([]);
  });
});

describe("PublicPagesRefreshCard", () => {
  const render = (locale: "zh-Hant" | "en") =>
    renderToStaticMarkup(
      createElement(I18nProvider, { locale, messages: getMessages(locale) }, createElement(PublicPagesRefreshCard)),
    );

  it("speaks to the shop owner, not to a developer", () => {
    for (const html of [render("zh-Hant"), render("en")]) {
      expect(html).not.toMatch(/cache|快取|revalidat|CDN|R2|ISR/i);
      expect(html).toContain("<button");
    }
    expect(render("zh-Hant")).toContain("重新產生全部頁面");
  });
});
