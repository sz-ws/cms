import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/ext/dx/manifest";
import {
  capScriptData,
  DATA_MAX_CHARS,
  hashScripts,
  parseScriptsApproval,
  renderInlineScript,
  scriptRefs,
  renderScriptSrc,
  scriptHosts,
  scriptLiteral,
  type DeclarativeScript,
} from "../src/ext/dx/scripts";

// 1.48.0 manifest.scripts:schema 規則、核准用的 hash、設定值代入。

const GA4 = {
  kind: "declarative",
  id: "ga4-lite",
  name: "GA4",
  version: "1.0.0",
  coreApi: "^1.48.0",
  settings: [
    { key: "measurementId", label: "Measurement ID", type: "text", default: "" },
    { key: "apiSecret", label: "API secret", type: "text", secret: true, default: "" },
  ],
  scripts: [
    { src: "https://www.googletagmanager.com/gtag/js?id={{settings.measurementId}}" },
    {
      inline: "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',{{settings.measurementId}});",
      domains: ["www.google-analytics.com"],
    },
  ],
};

function withScripts(scripts: unknown, extra: Record<string, unknown> = {}) {
  return parseManifest({ ...GA4, ...extra, scripts });
}

describe("manifest.scripts schema", () => {
  it("accepts an external script plus an inline one that use a declared setting", () => {
    const r = parseManifest(GA4);
    expect(r.ok).toBe(true);
    expect(r.manifest?.scripts).toHaveLength(2);
  });

  it.each([
    ["plain http", [{ src: "http://example.com/a.js" }]],
    ["a host taken from settings", [{ src: "https://{{settings.measurementId}}/a.js" }]],
    ["a URL with no path", [{ src: "https://example.com" }]],
    ["both src and inline", [{ src: "https://example.com/a.js", inline: "x()" }]],
    ["neither src nor inline", [{ domains: ["example.com"] }]],
    ["an inline closing tag", [{ inline: "x()</script><img src=x>" }]],
    ["an inline HTML comment opener", [{ inline: "<!-- x()" }]],
    ["an invalid domain", [{ inline: "x()", domains: ["https://example.com"] }]],
    ["more than four scripts", Array.from({ length: 5 }, () => ({ inline: "x()" }))],
  ])("rejects %s", (_label, scripts) => {
    expect(withScripts(scripts).ok).toBe(false);
  });

  it("rejects a placeholder that points at an undeclared setting", () => {
    const r = withScripts([{ inline: "x({{settings.nope}})" }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no setting "nope"');
  });

  it("rejects a placeholder that points at a secret setting", () => {
    const r = withScripts([{ inline: "x({{settings.apiSecret}})" }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("secret setting");
  });

  it("requires coreApi 1.48.0 or newer", () => {
    const r = parseManifest({ ...GA4, coreApi: "^1.47.0" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("coreApi");
  });
});

describe("hashScripts", () => {
  const scripts: DeclarativeScript[] = [
    { src: "https://example.com/a.js" },
    { inline: "x()", domains: ["api.example.com"] },
  ];

  it("ignores the key order the manifest was written in", async () => {
    const reordered = [
      { src: "https://example.com/a.js" },
      { domains: ["api.example.com"], inline: "x()" },
    ] as DeclarativeScript[];
    expect(await hashScripts(reordered)).toBe(await hashScripts(scripts));
  });

  it("changes when the code or the domains change", async () => {
    const base = await hashScripts(scripts);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashScripts([scripts[0], { ...scripts[1], inline: "y()" }])).not.toBe(base);
    expect(await hashScripts([scripts[0], { ...scripts[1], domains: ["evil.example"] }])).not.toBe(base);
  });
});

describe("setting values in scripts", () => {
  const LINE_SEPARATOR = String.fromCharCode(0x2028);

  it.each([
    ["a quote breakout", "'; fetch('/api/users'); '"],
    ["a template substitution", "${fetch('/api/users')}"],
    ["a closing script tag", "</script><img src=x onerror=alert(1)>"],
    ["a comment terminator", "*/ fetch('/x') /*"],
    ["a line separator", `a${LINE_SEPARATOR}b`],
  ])("keeps %s inside a plain literal", (_label, value) => {
    const literal = scriptLiteral(value);
    // 輸出只剩 JSON 字串本身:沒有任何能在某個 JS/HTML 位置提早結束的字元…
    expect(literal).not.toMatch(/['`$<>&/*]/);
    expect(literal.includes(LINE_SEPARATOR)).toBe(false);
    // …而且代表的值一字不差。
    expect(JSON.parse(literal)).toBe(value);
  });

  it("writes a missing value as null", () => {
    expect(scriptLiteral(undefined)).toBe("null");
    expect(renderInlineScript("x({{settings.a}})", {})).toBe("x(null)");
  });

  it("fills every placeholder in inline code", () => {
    expect(renderInlineScript("a({{ settings.id }}, {{settings.id}})", { id: "G-1" })).toBe(
      'a("G-1", "G-1")',
    );
  });

  it("encodes values in a src and keeps its host", () => {
    const src = renderScriptSrc("https://example.com/a.js?id={{settings.id}}", {
      id: "x&y=1#@evil.example/",
    });
    expect(src).not.toBeNull();
    const url = new URL(src!);
    expect(url.host).toBe("example.com");
    expect(url.searchParams.get("id")).toBe("x&y=1#@evil.example/");
    expect(url.searchParams.get("y")).toBeNull();
  });

  it("lists the hosts a set of scripts reaches", () => {
    expect(
      scriptHosts([
        { src: "https://www.googletagmanager.com/gtag/js" },
        { inline: "x()", domains: ["www.google-analytics.com", "www.googletagmanager.com"] },
      ]),
    ).toEqual(["www.googletagmanager.com", "www.google-analytics.com"]);
  });
});

describe("parseScriptsApproval", () => {
  const hash = "a".repeat(64);

  it("reads a stored approval", () => {
    expect(parseScriptsApproval(JSON.stringify({ hash, by: "a@t.co", at: 1 }))).toEqual({
      hash,
      by: "a@t.co",
      at: 1,
    });
  });

  it.each([null, "", "not json", JSON.stringify({ hash: "short", by: "a", at: 1 }), JSON.stringify({ hash })])(
    "treats %s as not approved",
    (raw) => {
      expect(parseScriptsApproval(raw)).toBeNull();
    },
  );
});

describe("content and feed placeholders", () => {
  const WITH_TYPES = {
    ...GA4,
    contentTypes: [
      { name: "sample", label: "Sample", fields: [{ key: "product", type: "text", label: "Product" }] },
      { name: "inbox", kind: "submission", label: "Inbox", fields: [{ key: "message", type: "text", label: "Message" }] },
    ],
  };
  const parse = (inline: string) => parseManifest({ ...WITH_TYPES, scripts: [{ inline }] });

  it("reads each kind of placeholder once, in order", () => {
    expect(scriptRefs("a({{settings.x}}, {{content.sample}}, {{feed.shop.recentPurchases}}, {{content.sample}})")).toEqual([
      { ns: "settings", name: "x", path: "settings.x" },
      { ns: "content", name: "sample", path: "content.sample" },
      { ns: "feed", name: "shop.recentPurchases", path: "feed.shop.recentPurchases" },
    ]);
  });

  it("accepts own content, another extension's content, and feeds in inline code", () => {
    const r = parse("x({{content.sample}}, {{content.catalog.product}}, {{feed.shop.recentPurchases}})");
    expect(r.error).toBeUndefined();
  });

  it.each([
    ["an undeclared own type", "x({{content.nope}})", 'no content type "nope"'],
    ["an inbox type", "x({{content.inbox}})", "inbox content type"],
    ["a feed without an extension", "x({{feed.recentPurchases}})", "<extId>.<name>"],
  ])("rejects %s", (_label, inline, message) => {
    const r = parse(inline);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });

  it("keeps data out of script addresses", () => {
    const r = parseManifest({ ...WITH_TYPES, scripts: [{ src: "https://example.com/a.js?d={{content.sample}}" }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("only be used in inline scripts");
  });

  it("fills content and feed data as literals and missing data as null", () => {
    const code = renderInlineScript(
      "a({{content.sample}}, {{feed.shop.recentPurchases}}, {{settings.id}})",
      { id: "G-1" },
      { "content.sample": [{ id: "1", data: { product: "</script>" } }] },
    );
    expect(code).toBe('a([{"id":"1","data":{"product":"\\u003c\\u002fscript\\u003e"}}], null, "G-1")');
  });

  it("trims oversized data from the end instead of dropping it all", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ i, text: "x".repeat(2000) }));
    const capped = capScriptData(big) as unknown[];
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(big.length);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(DATA_MAX_CHARS);
    expect(capped[0]).toEqual(big[0]);
    expect(capScriptData({ text: "x".repeat(DATA_MAX_CHARS) })).toBeNull();
  });
});
