import { beforeEach, describe, expect, it, vi } from "vitest";

// 2.0:草稿預覽。公開頁整頁存起來給每個訪客;編輯要看還沒發佈的內容,走 Next 的 draft mode:
// GET /api/preview?path=/blog/x 給登入的編輯開 draft mode(一個 cookie),轉到那一頁。帶著那個 cookie
// 的請求 OpenNext 不從快取回應,Next 逐請求渲染,DetailView 看到 draftMode 就連草稿一起讀。
// GET /api/preview?exit=1&path=… 關掉。

const state = vi.hoisted(() => ({
  user: null as null | { role: string },
  enabled: false,
  calls: [] as string[],
}));

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => {
      if (!state.user) throw new actual.AuthError(401);
      if (state.user.role === "guest") throw new actual.AuthError(403);
      return state.user;
    },
  };
});
vi.mock("next/headers", () => ({
  draftMode: async () => ({
    get isEnabled() {
      return state.enabled;
    },
    enable: () => {
      state.enabled = true;
      state.calls.push("enable");
    },
    disable: () => {
      state.enabled = false;
      state.calls.push("disable");
    },
  }),
}));

import { GET } from "../src/app/api/preview/route";
import { previewPath } from "../src/lib/preview";

const get = (query: string) => GET(new Request(`https://site.test/api/preview${query}`));

beforeEach(() => {
  state.user = { role: "editor" };
  state.enabled = false;
  state.calls = [];
});

describe("previewPath", () => {
  it("keeps site paths and refuses anything that leaves the public site", () => {
    expect(previewPath("/blog/hello")).toBe("/blog/hello");
    expect(previewPath("/")).toBe("/");
    for (const bad of [null, "", "blog", "//evil.com", "/\\evil.com", "https://evil.com", "/admin", "/admin/x", "/api/x", "/login", "/a b"]) {
      expect(previewPath(bad)).toBeNull();
    }
  });
});

describe("GET /api/preview", () => {
  it("turns draft mode on for a signed-in editor and goes to the page", async () => {
    const res = await get("?path=%2Fblog%2Fhello");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/blog/hello");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(state.calls).toEqual(["enable"]);
  });

  it("turns it off again with exit=1", async () => {
    state.enabled = true;
    const res = await get("?exit=1&path=%2Fblog%2Fhello");
    expect(res.status).toBe(307);
    expect(state.calls).toEqual(["disable"]);
  });

  it("refuses visitors who are not signed in, guests, and paths outside the public site", async () => {
    state.user = null;
    expect((await get("?path=%2F")).status).toBe(401);
    state.user = { role: "guest" };
    expect((await get("?path=%2F")).status).toBe(403);
    state.user = { role: "editor" };
    expect((await get("?path=%2F%2Fevil.com")).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});
