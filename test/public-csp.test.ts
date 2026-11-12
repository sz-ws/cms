import { describe, it, expect, vi } from "vitest";

// 公開頁的 CSP(2.0):公開頁整頁存起來給每個訪客,所以 CSP 是 next.config.ts 的固定標頭
// (publicPolicy + publicReportOnlyPolicy),沒有逐請求的 nonce,也沒有逐站的主機白名單;
// middleware 只跑在 /admin;scripts-widget 不讀請求標頭。後台那份 Report-Only 一字不變。

const headerState = vi.hoisted(() => ({ nonce: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.nonce ? { "x-nonce": headerState.nonce } : {}),
}));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/ext/dx/runtime", () => ({
  getContentProvider: async () => ({ query: async () => ({ items: [], total: 0 }) }),
}));

import { NextRequest } from "next/server";
import {
  PUBLIC_PAGES_SOURCE,
  REPORT_ONLY_PATHS,
  publicPolicy,
  publicReportOnlyPolicy,
  reportOnlyPolicy,
} from "../src/lib/csp";
import { hashScripts } from "../src/ext/dx/scripts";
import { middleware, config as middlewareConfig } from "../src/middleware";
import { makeScriptsWidget } from "../src/ext/dx/scripts-widget";
import type { DeclarativeManifest } from "../src/ext/dx/manifest";

// 1.50.0 之前 next.config.ts 對全站送的那一份,後台與 API 必須一字不差地繼續收到。
const PREVIOUS_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report";

const GA = [
  { src: "https://www.googletagmanager.com/gtag/js?id={{settings.id}}" },
  { inline: "window.dataLayer=window.dataLayer||[];", domains: ["www.google-analytics.com", "*.doubleclick.net"] },
];

describe("policy strings", () => {
  it("admin and API keep the previous Report-Only policy exactly", () => {
    expect(reportOnlyPolicy()).toBe(PREVIOUS_POLICY);
  });

  it("knows which paths get the public policy", () => {
    // next.config.ts 的 source 寫法是 "/:path(<regex>)";把括號裡的 regex 拿出來比對。
    const pattern = new RegExp(`^/${PUBLIC_PAGES_SOURCE.slice("/:path(".length, -1)}$`);
    for (const path of ["/", "/products", "/blog/hello-world", "/login/extra", "/blog/v1.2-release", "/robots.txt", "/oauth/authorize"]) {
      expect(pattern.test(path)).toBe(true);
    }
    for (const path of ["/admin", "/admin/settings", "/login", "/setup", "/api/files/x", "/_next/static/a.js"]) {
      expect(pattern.test(path)).toBe(false);
    }
    expect(REPORT_ONLY_PATHS).toContain("/admin/:path*");
  });
});

describe("middleware", () => {
  const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    new NextRequest(`https://site.test${path}`, init);

  // 2.0 phase 2:middleware 只跑在 /admin。公開頁(包含 OpenNext 快取命中的那些)、/login、/setup、
  // /api、robots.txt 這類檔案都不經過它 —— CSP 全部是 next.config.ts 的固定標頭。
  // 例外:帶著 draft mode cookie 的公開頁請求(草稿預覽,每次驗編輯身分,見 test/preview-access.test.ts)。
  it("only runs for the admin area, and for public pages only with the draft mode cookie", () => {
    expect(middlewareConfig.matcher).toEqual([
      "/admin",
      "/admin/:path*",
      { source: PUBLIC_PAGES_SOURCE, has: [{ type: "cookie", key: "__prerender_bypass" }] },
    ]);
  });

  it("sends a visitor without a session cookie to the login page, and sets no CSP", async () => {
    const admin = await middleware(request("/admin/settings"));
    expect(admin.status).toBe(307);
    expect(admin.headers.get("location")).toBe("https://site.test/login?next=%2Fadmin%2Fsettings");
    expect(admin.headers.get("content-security-policy")).toBeNull();
  });

  it("passes the path to the admin layout when there is a session cookie", async () => {
    const res = await middleware(request("/admin/users", { headers: { cookie: "session=x" } }));
    expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/admin/users");
  });
});

describe("static public policy (2.0)", () => {
  it("allows inline scripts and https hosts, keeps object-src, base-uri and frame-ancestors", () => {
    expect(publicPolicy()).toBe(
      "script-src 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri /api/csp-report",
    );
    expect(publicPolicy(true)).toMatch(/^script-src 'self' 'unsafe-inline' https: 'unsafe-eval';/);
  });

  it("the public Report-Only policy is the admin one with the public script rule and the map frame", () => {
    expect(publicReportOnlyPolicy()).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-src 'self' https://www.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report",
    );
    expect(publicReportOnlyPolicy()).not.toContain("wasm-unsafe-eval");
  });
});

describe("scripts widget (2.0)", () => {
  it("renders scripts without a nonce and without reading request headers", async () => {
    headerState.nonce = "abcdefghijklmnopqrstuv==";
    const manifest = {
      kind: "declarative",
      id: "ga",
      name: "GA",
      version: "1.0.0",
      coreApi: ">=1.48.0",
      settings: [{ key: "id", label: "ID", type: "text", default: "G-1" }],
      scripts: GA,
    } as unknown as DeclarativeManifest;
    const Widget = makeScriptsWidget("ga", manifest, { hash: await hashScripts(GA), by: "a", at: 1 });
    const out = (await (Widget as unknown as () => Promise<{ props: { children: { props: Record<string, unknown> }[] } }>)())!;
    const [external, inline] = out.props.children;
    expect(external.props.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-1");
    expect(external.props.nonce).toBeUndefined();
    expect(inline.props.nonce).toBeUndefined();
  });
});
