import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// /login(1.55.0 統一登入入口):網站有登入頁(插件宣告 signInPage)就轉過去,?next= 一起帶過去,
// 登入完才回得到原本的頁面(例如結帳頁的「登入」連到 /login?next=/shop/checkout)。

const state = vi.hoisted(() => ({
  /** users 表有沒有人;沒有 → /setup。 */
  hasUsers: true,
  /** publicSignInPage() 的回傳;null = 沒有插件宣告登入頁。 */
  page: null as string | null,
}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("@/lib/db", () => ({
  db: () => ({ select: () => ({ from: () => ({ limit: async () => (state.hasUsers ? [{ id: "u1" }] : []) }) }) }),
}));
vi.mock("@/lib/schema", () => ({ users: { id: "id" } }));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "zh-Hant", getMessages: () => ({}) }));
vi.mock("@/lib/i18n/I18nProvider", () => ({ I18nProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/oidc", () => ({ listLoginProviders: async () => [] }));
vi.mock("@/lib/email", () => ({ emailReady: async () => false }));
vi.mock("@/lib/sign-in-page", () => ({ publicSignInPage: async () => state.page }));
vi.mock("../src/app/(admin)/login/LoginScreen", () => ({
  LoginScreen: ({ next }: { next?: string }) => createElement("div", { "data-next": String(next) }, "LOGIN-FORM"),
}));

import LoginPage from "../src/app/(admin)/login/page";

const open = (query: Record<string, string>) => LoginPage({ searchParams: Promise.resolve(query) });

/** /login 轉去哪;沒轉(畫了後台的登入表單)是 null。 */
async function redirectOf(query: Record<string, string>): Promise<string | null> {
  try {
    await open(query);
    return null;
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
}

beforeEach(() => {
  state.hasUsers = true;
  state.page = "/account/sign-in";
});

describe("/login 轉到網站的登入頁", () => {
  it("帶著 next:登入完回到原本的頁面", async () => {
    expect(await redirectOf({ next: "/shop/checkout" })).toBe("/account/sign-in?next=%2Fshop%2Fcheckout");
    expect(await redirectOf({ next: "/shop/orders" })).toBe("/account/sign-in?next=%2Fshop%2Forders");
  });

  it("OAuth 的錯誤碼改名 login_error 一起帶過去;沒有 next 就不帶", async () => {
    expect(await redirectOf({ next: "/blog", error: "oauth_denied" })).toBe("/account/sign-in?next=%2Fblog&login_error=oauth_denied");
    expect(await redirectOf({})).toBe("/account/sign-in");
  });

  it("?form=1 留在後台的登入表單,next 交給表單", async () => {
    expect(await redirectOf({ form: "1", next: "/shop/checkout" })).toBeNull();
    expect(renderToStaticMarkup(await open({ form: "1", next: "/shop/checkout" }))).toContain('data-next="/shop/checkout"');
  });

  it("沒有插件宣告登入頁:後台的登入表單,next 交給表單", async () => {
    state.page = null;
    expect(renderToStaticMarkup(await open({ next: "/shop/checkout" }))).toContain('data-next="/shop/checkout"');
  });

  it("還沒有任何使用者:先去 /setup", async () => {
    state.hasUsers = false;
    expect(await redirectOf({ next: "/shop/checkout" })).toBe("/setup");
  });
});
