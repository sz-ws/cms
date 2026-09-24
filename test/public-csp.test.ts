import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

// 1.50.0:公開頁 enforce CSP。
//   - policy 字串(lib/csp.ts):後台那份與 1.50.0 之前一字不差;公開頁只 enforce
//     執行程式的指令;寫進標頭的主機值擋掉任何能多塞指令的形狀
//   - 白名單(lib/public-csp.ts):只收啟用中、核准紀錄對得上內容的 scripts
//   - middleware:nonce 同時進請求(給 Next 與 scripts-widget)與回應
//   - scripts-widget:inline 帶 nonce,外部 script 不帶(由主機白名單放行)

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
});

describe("middleware", () => {
  const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    new NextRequest(`https://site.test${path}`, init);

  it("sends an enforced policy with a fresh nonce and the approved hosts on public pages", async () => {
    await insertDx("ga", GA, await approvalFor(GA));
    const res = await middleware(request("/products"));
    const enforced = res.headers.get("content-security-policy") ?? "";
    const nonce = enforced.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(enforced).toContain("https://www.googletagmanager.com");
    expect(enforced).toContain("https://*.doubleclick.net");
    expect(res.headers.get("content-security-policy-report-only")).toContain(`'nonce-${nonce}'`);
    // 請求標頭(Next 從這裡抓 nonce;scripts-widget 讀 x-nonce)。
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(enforced);

    const again = await middleware(request("/products"));
    expect(again.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
  });

  it("ignores a nonce the browser tries to send itself", async () => {
    const res = await middleware(
      request("/", { headers: { "x-nonce": "attacker", "content-security-policy": "script-src 'nonce-attacker'" } }),
    );
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
    const rsc = await middleware(request("/", { headers: { rsc: "1", "x-nonce": "attacker" } }));
    expect(rsc.headers.get("content-security-policy")).toBeNull();
    // 被刪掉的請求標頭列在 override 清單外 = 不會送進渲染。
    expect(rsc.headers.get("x-middleware-override-headers")?.split(",")).not.toContain("x-nonce");
  });

  it("leaves admin and login to next.config's Report-Only policy", async () => {
    const admin = await middleware(request("/admin/settings"));
    expect(admin.status).toBe(307);
    expect(admin.headers.get("content-security-policy")).toBeNull();
    const login = await middleware(request("/login"));
    expect(login.headers.get("content-security-policy")).toBeNull();
    expect(login.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("files get the admin Report-Only policy, pages with a dot in the path get the enforced one", async () => {
    const file = await middleware(request("/robots.txt"));
    expect(file.headers.get("content-security-policy")).toBeNull();
    expect(file.headers.get("content-security-policy-report-only")).toBe(PREVIOUS_POLICY);
    const page = await middleware(request("/blog/v1.2-release"));
    expect(page.headers.get("content-security-policy")).toMatch(/'nonce-/);
  });

  it("reuses the allowlist until the plugin table changes", async () => {
    await insertDx("ga", GA, await approvalFor(GA));
    const hostsIn = async () => (await middleware(request("/products"))).headers.get("content-security-policy") ?? "";
    expect(await hostsIn()).toContain("https://www.googletagmanager.com");
    // 內容改了但版本戳沒動(沒有寫入路徑會這樣做):沿用上一次的結果。
    await d1().prepare("UPDATE declarative_extensions SET scripts_approval = NULL WHERE id = 'ga'").run();
    expect(await hostsIn()).toContain("https://www.googletagmanager.com");
    // 撤銷核准的寫入會推進 updated_at:下一個請求就看得見。
    await d1().prepare("UPDATE declarative_extensions SET updated_at = 2 WHERE id = 'ga'").run();
    expect(await hostsIn()).not.toContain("https://www.googletagmanager.com");
  });

  it("CMS_CSP=report-only turns enforcement off but keeps reporting", async () => {
    cfState.csp = "report-only";
    const res = await middleware(request("/products"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toMatch(/'nonce-/);
    expect(res.headers.get("x-middleware-request-content-security-policy-report-only")).toMatch(/'nonce-/);
  });

  it("still enforces (without third-party hosts) when the allowlist cannot be read", async () => {
    await d1().exec("ALTER TABLE declarative_extensions RENAME TO declarative_extensions_away;");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await middleware(request("/products"));
      // 測試環境不是 production,所以會多一個開發用的 'unsafe-eval';重點是沒有任何主機。
      expect(res.headers.get("content-security-policy")).toMatch(/^script-src 'self' 'nonce-[^']+'( 'unsafe-eval')?; object-src/);
    } finally {
      errors.mockRestore();
      await d1().exec("ALTER TABLE declarative_extensions_away RENAME TO declarative_extensions;");
    }
  });
});

describe("scripts widget nonce", () => {
  it("puts the request nonce on inline scripts only", async () => {
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
    expect(inline.props.nonce).toBe("abcdefghijklmnopqrstuv==");
  });
});
