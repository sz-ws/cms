import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 2.0:/login 是存起來的頁面(跟公開頁同一個形狀),HTML 對每個訪客都一樣。網址參數(next、error、
// form)與「是不是已經登入」在瀏覽器決定(decideLoginEntry);網站層級的事(有沒有人、插件的登入頁、
// 登入方式)畫進存起來的頁面,存檔時由 publicContentChanged 重算。
//
// 1.55.0 起的規則照舊:網站有登入頁(插件宣告 signInPage)就轉過去,?next= 一起帶過去,登入完才
// 回得到原本的頁面(例如結帳頁的「登入」連到 /login?next=/shop/checkout)。

const state = vi.hoisted(() => ({
  /** users 表有沒有人;沒有 → /setup。 */
  hasUsers: true,
  /** publicSignInPage() 的回傳;null = 沒有插件宣告登入頁。 */
  page: null as string | null,
  /** emailConfigured():寄得出信 / 沒設定 / 查不到。 */
  email: "ready" as "ready" | "unconfigured" | "error",
}));

class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("not found");
  },
}));
vi.mock("@/lib/db", () => ({
  db: () => ({ select: () => ({ from: () => ({ limit: async () => (state.hasUsers ? [{ id: "u1" }] : []) }) }) }),
}));
vi.mock("@/lib/schema", () => ({ users: { id: "id" } }));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "zh-Hant", getMessages: () => ({}) }));
vi.mock("@/lib/i18n/I18nProvider", () => ({ I18nProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/oidc", () => ({ listLoginProviders: async () => [{ id: "google", label: "Google" }] }));
vi.mock("@/lib/email", () => ({
  emailConfigured: async () => {
    if (state.email === "error") throw new Error("settings unreadable");
    return state.email === "ready";
  },
}));
vi.mock("@/lib/sign-in-page", () => ({ publicSignInPage: async () => state.page }));
vi.mock("../src/app/(admin)/login/LoginEntry", () => ({
  LoginEntry: (props: Record<string, unknown>) => createElement("div", { "data-props": JSON.stringify(props) }, "LOGIN-ENTRY"),
}));

import * as loginRoute from "../src/app/(admin)/login/[[...rest]]/page";
import { decideLoginEntry } from "../src/app/(admin)/login/login-entry";

const LoginPage = loginRoute.default;

async function propsOf(rest?: string[]): Promise<Record<string, unknown>> {
  const html = renderToStaticMarkup(await LoginPage({ params: Promise.resolve({ rest }) }));
  const match = /data-props="([^"]*)"/.exec(html);
  if (!match) throw new Error(`no LoginEntry in ${html}`);
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, unknown>;
}

const decide = (search: string, options: { page?: string | null; hint?: boolean; needsSetup?: boolean } = {}) =>
  decideLoginEntry({
    search,
    signInPage: options.page ?? null,
    signedInHint: options.hint ?? false,
    needsSetup: options.needsSetup ?? false,
  });

beforeEach(() => {
  state.hasUsers = true;
  state.page = "/account/sign-in";
  state.email = "ready";
});

describe("/login 是存起來的頁面", () => {
  it("用公開頁的路由設定:第一次造訪才算、只在失效時重算、讀了 cookies()/searchParams 就報錯", () => {
    expect(loginRoute.dynamic).toBe("error");
    expect(loginRoute.dynamicParams).toBe(true);
    expect(loginRoute.revalidate).toBe(false);
    expect(loginRoute.generateStaticParams()).toEqual([]);
  });

  it("畫進頁面的只有網站層級的事", async () => {
    const props = await propsOf();
    expect(props).toEqual({
      siteTitle: "My Site",
      signInPage: "/account/sign-in",
      needsSetup: false,
      providers: [{ id: "google", label: "Google" }],
      resetAvailable: true,
    });
  });

  it("還沒有任何使用者:頁面記著要先去 /setup", async () => {
    state.hasUsers = false;
    expect((await propsOf()).needsSetup).toBe(true);
  });

  // 沒設定寄信 → 不給「忘記密碼」,照樣存;查不到 → 這次渲染失敗(500,不存),下一次再算。
  it("寄信沒設定:不給忘記密碼;查不到:渲染失敗,不存一個少了忘記密碼的頁面", async () => {
    state.email = "unconfigured";
    expect((await propsOf()).resetAvailable).toBe(false);
    state.email = "error";
    await expect(propsOf()).rejects.toThrow("settings unreadable");
  });

  it("/login 底下沒有別的頁", async () => {
    await expect(propsOf(["x"])).rejects.toBeInstanceOf(NotFound);
  });
});

describe("瀏覽器決定:轉到網站的登入頁", () => {
  it("帶著 next:登入完回到原本的頁面", () => {
    expect(decide("?next=%2Fshop%2Fcheckout", { page: "/account/sign-in" })).toEqual({
      kind: "go",
      href: "/account/sign-in?next=%2Fshop%2Fcheckout",
    });
    expect(decide("?next=/shop/orders", { page: "/account/sign-in" })).toEqual({
      kind: "go",
      href: "/account/sign-in?next=%2Fshop%2Forders",
    });
  });

  it("OAuth 的錯誤碼改名 login_error 一起帶過去;沒有 next 就不帶", () => {
    expect(decide("?next=/blog&error=oauth_denied", { page: "/account/sign-in" })).toEqual({
      kind: "go",
      href: "/account/sign-in?next=%2Fblog&login_error=oauth_denied",
    });
    expect(decide("", { page: "/account/sign-in" })).toEqual({ kind: "go", href: "/account/sign-in" });
  });

  it("?form=1 留在後台的登入表單,next 交給表單", () => {
    expect(decide("?form=1&next=/shop/checkout", { page: "/account/sign-in" })).toEqual({
      kind: "form",
      next: "/shop/checkout",
      oauthError: undefined,
    });
  });

  it("沒有插件宣告登入頁:後台的登入表單,next 與錯誤碼交給表單", () => {
    expect(decide("?next=/shop/checkout&error=oauth_denied")).toEqual({
      kind: "form",
      next: "/shop/checkout",
      oauthError: "oauth_denied",
    });
  });

  it("還沒有任何使用者:先去 /setup", () => {
    expect(decide("?next=/shop/checkout", { needsSetup: true, page: "/account/sign-in" })).toEqual({
      kind: "go",
      href: "/setup",
    });
  });
});

describe("瀏覽器決定:已經登入", () => {
  it("有登入提示才問伺服器(/api/auth/continue 驗 session、決定去哪、驗 next)", () => {
    expect(decide("?next=%2Fadmin%2Fcontent", { hint: true })).toEqual({
      kind: "signed-in",
      href: "/api/auth/continue?next=%2Fadmin%2Fcontent",
    });
    expect(decide("", { hint: true })).toEqual({ kind: "signed-in", href: "/api/auth/continue" });
  });

  it("沒有提示:直接給表單,不問伺服器", () => {
    expect(decide("?next=/admin").kind).toBe("form");
  });

  it("?form=1 照樣給表單(插件頁壞掉時後台人員的退路)", () => {
    expect(decide("?form=1", { hint: true }).kind).toBe("form");
  });

  it("網站有自己的登入頁:轉過去,已登入的畫面由那一頁處理", () => {
    expect(decide("?next=/blog", { hint: true, page: "/account/sign-in" })).toEqual({
      kind: "go",
      href: "/account/sign-in?next=%2Fblog",
    });
  });
});
