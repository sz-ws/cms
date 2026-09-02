import { describe, it, expect } from "vitest";
import {
  readAuditQuery,
  auditHref,
} from "../src/app/(admin)/admin/agent/audit/audit-filter";

// URL → 篩選的純函式。這是整頁唯一把使用者可控字串翻成查詢條件的地方,
// 所以每一個「拒收」都要有一條測試。

describe("readAuditQuery", () => {
  it("defaults to the unfiltered first page", () => {
    expect(readAuditQuery({})).toEqual({ view: "all", tool: null, filter: {} });
  });

  it("maps views to kind / ok filters", () => {
    expect(readAuditQuery({ view: "read" }).filter).toEqual({ kind: "read" });
    expect(readAuditQuery({ view: "write" }).filter).toEqual({ kind: "write" });
    expect(readAuditQuery({ view: "failed" }).filter).toEqual({ ok: false });
  });

  it("ignores unknown views and takes the first of repeated params", () => {
    expect(readAuditQuery({ view: "nope" }).view).toBe("all");
    expect(readAuditQuery({ view: ["write", "read"] }).view).toBe("write");
  });

  it("accepts only registry-shaped tool names", () => {
    expect(readAuditQuery({ tool: "content.post.update" }).tool).toBe("content.post.update");
    expect(readAuditQuery({ tool: "core.stats.overview" }).filter.tool).toBe("core.stats.overview");
    for (const bad of ["Content.Post", "post", "a..b", "a.b;drop", " a.b", "a.b ", ""]) {
      expect(readAuditQuery({ tool: bad }).tool).toBeNull();
    }
  });

  it("only forwards a well-formed cursor", () => {
    const id = "0f6a1e2c-9b1d-4c7e-8f2a-1b2c3d4e5f60";
    expect(readAuditQuery({ before: `1700000000000.${id}` }).filter.cursor).toEqual({
      at: 1_700_000_000_000,
      id,
    });
    expect(readAuditQuery({ before: "garbage" }).filter.cursor).toBeUndefined();
  });
});

describe("auditHref", () => {
  it("omits defaults so the base URL stays canonical", () => {
    expect(auditHref({ view: "all", tool: null })).toBe("/admin/agent/audit");
  });

  it("encodes view, tool and cursor", () => {
    expect(auditHref({ view: "failed", tool: "content.post.update" }, "1.abc")).toBe(
      "/admin/agent/audit?view=failed&tool=content.post.update&before=1.abc",
    );
  });

  it("round-trips through readAuditQuery", () => {
    const q = { view: "write" as const, tool: "shop.orders.verify" };
    const href = auditHref(q);
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    const back = readAuditQuery(sp);
    expect(back.view).toBe("write");
    expect(back.tool).toBe("shop.orders.verify");
    expect(back.filter).toEqual({ kind: "write", tool: "shop.orders.verify" });
  });
});
