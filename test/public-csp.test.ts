import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.50.0:公開頁 enforce CSP。
//   - policy 字串(lib/csp.ts):後台那份與 1.50.0 之前一字不差;公開頁只 enforce
//     執行程式的指令;寫進標頭的主機值擋掉任何能多塞指令的形狀
//   - 白名單(lib/public-csp.ts):只收啟用中、核准紀錄對得上內容的 scripts
//   - 2.0:公開頁整頁存起來,middleware 不再產生 nonce;CSP 是 next.config.ts 的固定標頭
//     (publicPolicy),scripts-widget 不讀請求標頭

const cfState = vi.hoisted(() => ({ csp: undefined as string | undefined }));
vi.mock("@opennextjs/cloudflare/cloudflare-context", () => ({
  getCloudflareContext: () => ({
    env: { DB: (env as { DB: unknown }).DB, CMS_CSP: cfState.csp },
  }),
}));

const headerState = vi.hoisted(() => ({ nonce: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerState.nonce ? { "x-nonce": headerState.nonce } : {}),
}));
vi.mock("@/lib/settings", () => ({ getSetting: async (_key: string, fallback: unknown) => fallback }));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/ext/dx/content-cache", () => ({ cachedPublicQuery: async () => ({ items: [] }) }));

import { NextRequest } from "next/server";
import {
  cspHostSources,
  createNonce,
  enforcedPublicPolicy,
  isPublicPagePath,
  publicPolicy,
  reportOnlyPolicy,
} from "../src/lib/csp";
import { approvedScriptHosts } from "../src/lib/public-csp";
import { hashScripts } from "../src/ext/dx/scripts";
import { middleware } from "../src/middleware";
import { makeScriptsWidget } from "../src/ext/dx/scripts-widget";
import type { DeclarativeManifest } from "../src/ext/dx/manifest";

const d1 = () => (env as { DB: D1Database }).DB;

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

  it("the enforced public policy only covers script execution", () => {
    const policy = enforcedPublicPolicy({ nonce: "abcdefghijklmnopqrstuv==", hosts: ["www.googletagmanager.com"] });
    expect(policy).toBe(
      "script-src 'self' 'nonce-abcdefghijklmnopqrstuv==' https://www.googletagmanager.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri /api/csp-report",
    );
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("strict-dynamic");
    expect(policy).not.toContain("form-action");
  });

  it("dev mode adds eval for React's dev tooling", () => {
    expect(enforcedPublicPolicy({ nonce: createNonce(), hosts: [], dev: true })).toContain("'unsafe-eval'");
    expect(enforcedPublicPolicy({ nonce: createNonce(), hosts: [] })).not.toContain("'unsafe-eval'");
  });

  it("the public Report-Only policy is the full target policy with the same nonce and hosts", () => {
    const policy = reportOnlyPolicy({
      nonce: "abcdefghijklmnopqrstuv==",
      hosts: ["www.google-analytics.com"],
      errorDsn: "https://key@errors.example.com/3",
    });
    expect(policy).toContain("script-src 'self' 'nonce-abcdefghijklmnopqrstuv==' https://www.google-analytics.com");
    expect(policy).toContain("img-src 'self' data: blob: https://www.google-analytics.com");
    expect(policy).toContain("connect-src 'self' https://www.google-analytics.com https://errors.example.com");
    expect(policy).toContain("frame-src 'self' https://www.google-analytics.com https://www.google.com");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("wasm-unsafe-eval");
  });

  it("public pages may embed a Google map; the admin policy has no frame-src", () => {
    expect(reportOnlyPolicy({ nonce: "abcdefghijklmnopqrstuv==", hosts: [] })).toContain("frame-src 'self' https://www.google.com;");
    expect(reportOnlyPolicy()).not.toContain("frame-src");
  });

  it("drops host values that could smuggle another directive into the header", () => {
    expect(
      cspHostSources([
        "www.googletagmanager.com",
        "*.doubleclick.net",
        "cdn.example.com:8443",
        "evil.com; script-src *",
        "evil.com 'unsafe-inline'",
        "http://evil.com",
        "*",
        "localhost",
        "WWW.GOOGLETAGMANAGER.COM",
      ]),
    ).toEqual(["https://www.googletagmanager.com", "https://*.doubleclick.net", "https://cdn.example.com:8443"]);
  });

  it("refuses a nonce that is not base64", () => {
    expect(() => enforcedPublicPolicy({ nonce: "x'; script-src *", hosts: [] })).toThrow();
    expect(createNonce()).not.toBe(createNonce());
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("knows which paths are public pages", () => {
    for (const path of ["/", "/products", "/blog/hello-world", "/login/extra", "/blog/v1.2-release", "/p/1.5"]) {
      expect(isPublicPagePath(path)).toBe(true);
    }
    for (const path of ["/admin", "/admin/settings", "/login", "/setup", "/api/files/x", "/_next/static/a.js", "/robots.txt", "/icon.svg", "/fonts/a/b.woff2"]) {
      expect(isPublicPagePath(path)).toBe(false);
    }
  });
});

async function insertDx(id: string, scripts: unknown, approval: string | null, enabled = 1) {
  await d1()
    .prepare(
      "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at, scripts_approval) VALUES (?, ?, '1.0.0', ?, NULL, 1, 1, ?)",
    )
    .bind(id, JSON.stringify({ kind: "declarative", id, name: id, version: "1.0.0", coreApi: "^1.48.0", scripts }), enabled, approval)
    .run();
}

const approvalFor = async (scripts: typeof GA) =>
  JSON.stringify({ hash: await hashScripts(scripts), by: "a@t.co", at: 1 });

beforeAll(async () => {
  await d1().exec(
    "CREATE TABLE IF NOT EXISTS declarative_extensions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT, stylesheet TEXT, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scripts_approval TEXT);",
  );
});

beforeEach(async () => {
  await d1().exec("DELETE FROM declarative_extensions;");
  cfState.csp = undefined;
  headerState.nonce = null;
});

describe("approved script hosts", () => {
  it("lists src hosts and declared domains of approved, enabled scripts", async () => {
    await insertDx("ga", GA, await approvalFor(GA));
    expect(await approvedScriptHosts(d1())).toEqual([
      "www.googletagmanager.com",
      "www.google-analytics.com",
      "*.doubleclick.net",
    ]);
  });

  it("skips scripts that are disabled, unapproved, changed since approval or malformed", async () => {
    const changed = [{ src: "https://cdn.changed.test/a.js" }];
    await insertDx("off", GA, await approvalFor(GA), 0);
    await insertDx("unapproved", GA, null);
    await insertDx("changed", changed, await approvalFor(GA));
    await insertDx("broken", "not an array", await approvalFor(GA));
    await insertDx("bad-approval", GA, "{not json");
    expect(await approvedScriptHosts(d1())).toEqual([]);
  });

  // 1.57.0:Firebase 登入的視窗要從 apis.google.com 載入 gapi,只在有啟用的 Firebase 登入時放行。
  it("allows apis.google.com only while a Firebase sign-in plugin is enabled", async () => {
    const insertLogin = async (id: string, enabled: number) =>
      d1()
        .prepare(
          "INSERT INTO declarative_extensions (id, manifest, version, enabled, source, installed_at, updated_at, scripts_approval) VALUES (?, ?, '1.0.0', ?, NULL, 1, 1, NULL)",
        )
        .bind(id, JSON.stringify({ kind: "declarative", id, name: id, version: "1.0.0", coreApi: "^1.57.0", loginProvider: { firebase: { signIn: "google.com" }, button: { label: "Google" } } }), enabled)
        .run();
    await insertLogin("login-off", 0);
    expect(await approvedScriptHosts(d1())).toEqual([]);
    await insertLogin("login-on", 1);
    await insertDx("ga", GA, await approvalFor(GA));
    const hosts = await approvedScriptHosts(d1());
    expect(hosts).toHaveLength(4);
    expect(hosts).toEqual(
      expect.arrayContaining(["apis.google.com", "www.googletagmanager.com", "www.google-analytics.com", "*.doubleclick.net"]),
    );
  });
});

describe("middleware", () => {
  const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    new NextRequest(`https://site.test${path}`, init);

  // 2.0:公開頁整頁存起來,CSP 改由 next.config.ts 送固定標頭(publicPolicy)。middleware
  // 對公開頁原樣放行:不產生 nonce、不送 CSP、不把任何東西寫進請求標頭。
  it("passes public pages through untouched: no nonce, no policy, no request headers", async () => {
    await insertDx("ga", GA, await approvalFor(GA));
    const res = await middleware(request("/products"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("leaves admin and login to next.config's Report-Only policy", async () => {
    const admin = await middleware(request("/admin/settings"));
    expect(admin.status).toBe(307);
    expect(admin.headers.get("content-security-policy")).toBeNull();
    const login = await middleware(request("/login"));
    expect(login.headers.get("content-security-policy")).toBeNull();
    expect(login.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("files get the admin Report-Only policy, pages with a dot in the path pass through", async () => {
    const file = await middleware(request("/robots.txt"));
    expect(file.headers.get("content-security-policy")).toBeNull();
    expect(file.headers.get("content-security-policy-report-only")).toBe(PREVIOUS_POLICY);
    const page = await middleware(request("/blog/v1.2-release"));
    expect(page.headers.get("content-security-policy")).toBeNull();
  });
});

describe("static public policy (2.0)", () => {
  it("allows inline scripts and https hosts, keeps object-src, base-uri and frame-ancestors", () => {
    expect(publicPolicy()).toBe(
      "script-src 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri /api/csp-report",
    );
    expect(publicPolicy(true)).toMatch(/^script-src 'self' 'unsafe-inline' https: 'unsafe-eval';/);
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
      coreApi: "^1.48.0",
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
