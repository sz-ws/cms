import { beforeEach, describe, expect, it, vi } from "vitest";

// core 1.82.0:網站網址與分享用網址。客人從哪個網址進來就留在哪個網址;分享連結用分享用網址開頭。

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, host: null as string | null, outside: false }));
vi.mock("@/lib/settings", () => ({ getPlainSetting: async (key: string, fallback: unknown) => (key in state.settings ? state.settings[key] : fallback) }));
// next/navigation 在 workers 測試池裡載不起來;site-origins 只用它的 unstable_rethrow。
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (state.outside) throw new Error("`headers` was called outside a request scope");
    return new Headers(state.host ? { host: state.host } : {});
  },
}));

import { originOf, ownOrigin, shareOrigin, siteOrigins, visitorOrigin } from "../src/lib/site-origins";

const SITE = "https://www.shop.example";
const SHARE = "https://short.example";

beforeEach(() => {
  state.settings = { "core.siteUrl": `${SITE}/`, "core.shareUrl": SHARE };
  state.host = null;
  state.outside = false;
});

describe("originOf", () => {
  it("keeps only the origin of an http(s) address", () => {
    expect(originOf("https://www.shop.example/x?y=1")).toBe(SITE);
    expect(originOf(" http://localhost:3000/ ")).toBe("http://localhost:3000");
    for (const raw of ["", "shop.example", "javascript:alert(1)", null, 42, "https://"]) expect(originOf(raw)).toBe("");
  });
});

describe("siteOrigins and shareOrigin", () => {
  it("lists the site URL first and the share address second, once each", async () => {
    expect(await siteOrigins()).toEqual([SITE, SHARE]);
    state.settings["core.shareUrl"] = `${SITE}/products`;
    expect(await siteOrigins()).toEqual([SITE]);
  });
  it("starts shared links with the share address, else the site URL, else nothing", async () => {
    expect(await shareOrigin()).toBe(SHARE);
    state.settings["core.shareUrl"] = "not a url";
    expect(await shareOrigin()).toBe(SITE);
    state.settings = {};
    expect(await shareOrigin()).toBe("");
    expect(await siteOrigins()).toEqual([]);
  });
});

describe("ownOrigin", () => {
  it("matches a URL or a Host header against the site's own addresses by host", () => {
    const origins = [SITE, SHARE];
    expect(ownOrigin("https://short.example/api/auth/oauth/x/start", origins)).toBe(SHARE);
    expect(ownOrigin("SHORT.example", origins)).toBe(SHARE);
    expect(ownOrigin("www.shop.example", origins)).toBe(SITE);
  });
  it("answers nothing for any other host, a different port or a malformed value", () => {
    const origins = [SITE, SHARE];
    for (const value of ["cms.example.workers.dev", "https://evil.example/", "short.example:8443", "", null, undefined, "https://"]) {
      expect(ownOrigin(value, origins)).toBe("");
    }
    expect(ownOrigin("short.example", [])).toBe("");
  });
});

describe("visitorOrigin", () => {
  it("is the address the request came in on when it is one of the site's own", async () => {
    state.host = "short.example";
    expect(await visitorOrigin()).toBe(SHARE);
    state.host = "www.shop.example";
    expect(await visitorOrigin()).toBe(SITE);
  });
  it("is empty on another host, without a Host header, or outside a request", async () => {
    state.host = "cms.example.workers.dev";
    expect(await visitorOrigin()).toBe("");
    state.host = null;
    expect(await visitorOrigin()).toBe("");
    state.outside = true;
    expect(await visitorOrigin()).toBe("");
  });
});
