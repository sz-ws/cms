import { describe, it, expect } from "vitest";
import { EXTENSION_ID_RE, assetContentType, isValidAssetFile } from "@/lib/registry-asset";

// Pure guards used by GET /api/registry/asset (marketplace media proxy).
// No D1/fetch involved — these are the allow-list rules that decide whether
// a `file` query param is safe to fetch and what Content-Type to serve it as.

describe("isValidAssetFile", () => {
  it("accepts known image extensions", () => {
    expect(isValidAssetFile("icon.png")).toBe(true);
    expect(isValidAssetFile("Banner.JPG")).toBe(true);
    expect(isValidAssetFile("shot-1.jpeg")).toBe(true);
    expect(isValidAssetFile("logo.webp")).toBe(true);
    expect(isValidAssetFile("anim.gif")).toBe(true);
    expect(isValidAssetFile("icon.svg")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidAssetFile("../x.png")).toBe(false);
    expect(isValidAssetFile("../../secret.png")).toBe(false);
    expect(isValidAssetFile("a/..%2f")).toBe(false);
    expect(isValidAssetFile("..%2f..%2fx.png")).toBe(false);
    expect(isValidAssetFile("a/b.png")).toBe(false); // no nested path segments at all
  });

  it("rejects disallowed extensions", () => {
    expect(isValidAssetFile("x.html")).toBe(false);
    expect(isValidAssetFile("x.js")).toBe(false);
    expect(isValidAssetFile("x.php")).toBe(false);
    expect(isValidAssetFile("noext")).toBe(false);
    expect(isValidAssetFile("trailing.")).toBe(false);
  });

  it("rejects filenames over the length cap or with a leading dot/dash", () => {
    expect(isValidAssetFile(".hidden.png")).toBe(false);
    expect(isValidAssetFile("-x.png")).toBe(false);
    expect(isValidAssetFile("a".repeat(60) + ".png")).toBe(false);
  });
});

describe("assetContentType", () => {
  it("maps known extensions to a safe MIME type, case-insensitively", () => {
    expect(assetContentType("icon.png")).toBe("image/png");
    expect(assetContentType("ICON.PNG")).toBe("image/png");
    expect(assetContentType("a.jpg")).toBe("image/jpeg");
    expect(assetContentType("a.jpeg")).toBe("image/jpeg");
    expect(assetContentType("a.webp")).toBe("image/webp");
    expect(assetContentType("a.gif")).toBe("image/gif");
    expect(assetContentType("a.svg")).toBe("image/svg+xml");
  });

  it("returns null for anything not on the allow-list", () => {
    expect(assetContentType("a.html")).toBeNull();
    expect(assetContentType("a.js")).toBeNull();
    expect(assetContentType("noext")).toBeNull();
  });
});

describe("EXTENSION_ID_RE", () => {
  it("matches valid extension ids", () => {
    expect(EXTENSION_ID_RE.test("blog")).toBe(true);
    expect(EXTENSION_ID_RE.test("my-ext-2")).toBe(true);
  });

  it("rejects path traversal and uppercase ids", () => {
    expect(EXTENSION_ID_RE.test("../../secret")).toBe(false);
    expect(EXTENSION_ID_RE.test("Blog")).toBe(false);
    expect(EXTENSION_ID_RE.test("")).toBe(false);
  });
});
