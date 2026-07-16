import { describe, it, expect } from "vitest";
import { compilePattern, matchSegments } from "../src/ext/dx/route-matcher";
import {
  buildSurfaceId,
  parseSurfaceId,
  surfaceIds,
} from "../src/ext/dx/surfaces";

// 純邏輯測試(無 I/O、無 bindings):forms 公開路由匹配 + progressive override surface-id。
// 兩者都是 core-v2 的核心純函式,且 forms 的 buildForms 直接依賴它們。

describe("route-matcher (forms public routes)", () => {
  it("compiles literal + param segments", () => {
    expect(compilePattern("/contact")).toEqual([{ literal: "contact" }]);
    expect(compilePattern("/forms/:name")).toEqual([
      { literal: "forms" },
      { param: "name" },
    ]);
  });

  it("matches literal exactly", () => {
    const t = compilePattern("/contact");
    expect(matchSegments(t, ["contact"])).toEqual({});
    expect(matchSegments(t, ["other"])).toBeNull();
  });

  it("matches param and captures it", () => {
    const t = compilePattern("/forms/:name");
    expect(matchSegments(t, ["forms", "contact"])).toEqual({
      name: "contact",
    });
  });

  it("rejects length mismatch (no partial match)", () => {
    const t = compilePattern("/a/:b");
    expect(matchSegments(t, ["a"])).toBeNull();
    expect(matchSegments(t, ["a", "b", "c"])).toBeNull();
  });
});

describe("surfaces (progressive override ids)", () => {
  it("surfaceIds helpers build the documented shape", () => {
    expect(surfaceIds.publicDetail("gallery.item")).toBe(
      "public:gallery.item:detail",
    );
    expect(surfaceIds.adminForm("blog.post")).toBe("admin:blog.post:form");
  });

  it("round-trips build ↔ parse", () => {
    const id = buildSurfaceId({
      kind: "public",
      contentType: "gallery.item",
      view: "list",
    });
    expect(parseSurfaceId(id)).toEqual({
      kind: "public",
      contentType: "gallery.item",
      view: "list",
    });
  });

  it("contentType's internal dot does NOT collide with the colon separator", () => {
    const id = buildSurfaceId({
      kind: "admin",
      contentType: "ext.typename",
      view: "collection",
    });
    expect(parseSurfaceId(id)?.contentType).toBe("ext.typename");
  });

  it("rejects malformed ids and bad kind/view combos", () => {
    expect(parseSurfaceId("bogus")).toBeNull();
    // detail is a public view, not admin → null
    expect(parseSurfaceId("admin:x:detail")).toBeNull();
    // collection is an admin view, not public → null
    expect(parseSurfaceId("public:x:collection")).toBeNull();
  });
});
