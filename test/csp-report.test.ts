import { describe, expect, it } from "vitest";
import {
  CSP_REPORT_MAX_ITEMS,
  describeCspViolation,
  normalizeCspReports,
} from "../src/lib/csp-report";

// 這一組測試守的是兩件事:兩種 wire 格式都認得,以及**外洩面**——正規化後的欄位
// 不准帶 host、query 或路徑細節出去(原始回報的 document-uri 含後台內容 id)。

const legacy = (over: Record<string, unknown> = {}) => ({
  "csp-report": {
    "document-uri": "https://site.example/admin/content/blog/post_9f3a?tab=seo",
    referrer: "",
    "violated-directive": "script-src-elem 'self'",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; script-src 'self'",
    "blocked-uri": "https://cdn.evil.example/track.js?uid=abc123",
    ...over,
  },
});

describe("normalizeCspReports — 舊格式(report-uri)", () => {
  it("讀 effective-directive,並把兩個網址都削掉", () => {
    const [v] = normalizeCspReports(legacy());
    expect(v).toEqual({
      directive: "script-src-elem",
      // blocked 只留 origin —— query 裡的 uid 不該進錯誤追蹤系統
      blocked: "https://cdn.evil.example",
      // documentPath 只留路徑 —— host 與 ?tab=seo 都丟掉
      documentPath: "/admin/content/blog/post_9f3a",
      disposition: "report",
    });
  });

  it("沒有 effective-directive 時退回 violated-directive 的第一個 token", () => {
    const body = legacy();
    delete (body["csp-report"] as Record<string, unknown>)[
      "effective-directive"
    ];
    expect(normalizeCspReports(body)[0].directive).toBe("script-src-elem");
  });

  it("關鍵字型的 blocked-uri 原樣保留(wasm-eval 是沙盒的直接證據)", () => {
    const cases = ["inline", "eval", "wasm-eval", "data"];
    for (const kw of cases) {
      const [v] = normalizeCspReports(legacy({ "blocked-uri": kw }));
      expect(v.blocked).toBe(kw);
    }
  });

  it("disposition 預設是 report,只有明講 enforce 才是 enforce", () => {
    expect(normalizeCspReports(legacy())[0].disposition).toBe("report");
    expect(
      normalizeCspReports(legacy({ disposition: "enforce" }))[0].disposition,
    ).toBe("enforce");
    // 認不得的值往保守那邊倒
    expect(
      normalizeCspReports(legacy({ disposition: "???" }))[0].disposition,
    ).toBe("report");
  });
});

describe("normalizeCspReports — 新格式(Reporting API)", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    type: "csp-violation",
    url: "https://site.example/admin/settings?group=ai",
    body: {
      documentURL: "https://site.example/admin/settings?group=ai",
      effectiveDirective: "style-src-attr",
      blockedURL: "inline",
      disposition: "report",
      ...over,
    },
  });

  it("認得陣列 payload 並讀 camelCase 欄位", () => {
    const [v] = normalizeCspReports([entry()]);
    expect(v.directive).toBe("style-src-attr");
    expect(v.blocked).toBe("inline");
    expect(v.documentPath).toBe("/admin/settings");
  });

  it("丟掉非 csp-violation 的 report(deprecation / intervention)", () => {
    const mixed = [entry(), { type: "deprecation", body: { id: "x" } }];
    expect(normalizeCspReports(mixed)).toHaveLength(1);
  });

  it("一次 payload 最多收 CSP_REPORT_MAX_ITEMS 筆", () => {
    const many = Array.from({ length: CSP_REPORT_MAX_ITEMS + 7 }, () =>
      entry(),
    );
    expect(normalizeCspReports(many)).toHaveLength(CSP_REPORT_MAX_ITEMS);
  });
});

describe("normalizeCspReports — 不可信輸入", () => {
  it("認不出來的東西一律回空陣列,不 throw", () => {
    const junk = [null, undefined, 42, "", "hello", {}, [], { foo: "bar" }];
    for (const j of junk) {
      expect(() => normalizeCspReports(j)).not.toThrow();
      expect(normalizeCspReports(j)).toEqual([]);
    }
  });

  it("欄位型別錯誤時給預設值而不是崩掉", () => {
    const [v] = normalizeCspReports({
      "csp-report": {
        "effective-directive": 123,
        "blocked-uri": { nope: true },
        "document-uri": null,
      },
    });
    expect(v).toEqual({
      directive: "unknown",
      blocked: "unknown",
      documentPath: "/",
      disposition: "report",
    });
  });

  it("超長字串被截斷(tag 不是拿來裝內容的)", () => {
    const [v] = normalizeCspReports(
      legacy({ "effective-directive": "d".repeat(5_000) }),
    );
    expect(v.directive.length).toBeLessThanOrEqual(120);
  });

  it("壞掉的網址不會讓 URL 解析炸開", () => {
    const [v] = normalizeCspReports(
      legacy({ "blocked-uri": "https://[not a url" }),
    );
    expect(v.blocked).toBe("unknown");
  });
});

describe("describeCspViolation", () => {
  it("摘要不含 host、query 或原始 policy", () => {
    const line = describeCspViolation(normalizeCspReports(legacy())[0]);
    expect(line).toBe(
      "CSP report: script-src-elem blocked https://cdn.evil.example on /admin/content/blog/post_9f3a",
    );
    expect(line).not.toContain("uid=abc123");
    expect(line).not.toContain("tab=seo");
    expect(line).not.toContain("original-policy");
  });
});
