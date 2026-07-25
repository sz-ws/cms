import { describe, it, expect } from "vitest";

// 圖片變體的 URL 契約。純函式,沒有 binding、沒有 I/O —— 這一層就是 render 端與
// /api/files 路由之間的唯一約定,所以測得比較細。

import {
  VARIANT_WIDTHS,
  DEFAULT_VARIANT_FORMAT,
  FORMAT_CONTENT_TYPE,
  buildSrcSet,
  fileUrl,
  isTransformableContentType,
  isTransformableKey,
  parseVariantRequest,
  snapWidth,
  variantEtag,
  variantUrl,
} from "@/lib/image-variants";

const KEY = "core/2026/07/abc123.jpg";

describe("snapWidth", () => {
  it("snaps up to the next allowed tier", () => {
    expect(snapWidth(1)).toBe(320);
    expect(snapWidth(320)).toBe(320);
    expect(snapWidth(321)).toBe(640);
    expect(snapWidth(1000)).toBe(1280);
  });

  it("clamps above the largest tier", () => {
    expect(snapWidth(99999)).toBe(VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1]);
  });

  it("rejects non-positive / non-finite input", () => {
    expect(snapWidth(0)).toBeUndefined();
    expect(snapWidth(-5)).toBeUndefined();
    expect(snapWidth(Number.NaN)).toBeUndefined();
    expect(snapWidth(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("transformable detection", () => {
  it("accepts the four still formats", () => {
    for (const ct of ["image/jpeg", "image/png", "image/webp", "image/avif"]) {
      expect(isTransformableContentType(ct)).toBe(true);
    }
  });

  it("rejects gif and svg (animation / vector are deliberately excluded)", () => {
    expect(isTransformableContentType("image/gif")).toBe(false);
    expect(isTransformableContentType("image/svg+xml")).toBe(false);
    expect(isTransformableKey("core/2026/07/a.gif")).toBe(false);
    expect(isTransformableKey("core/2026/07/a.svg")).toBe(false);
  });

  it("rejects non-images", () => {
    expect(isTransformableContentType("application/pdf")).toBe(false);
    expect(isTransformableKey("core/2026/07/a.pdf")).toBe(false);
    expect(isTransformableKey("core/2026/07/noext")).toBe(false);
  });

  it("tolerates content-type parameters and casing", () => {
    expect(isTransformableContentType("IMAGE/JPEG; charset=binary")).toBe(true);
    expect(isTransformableKey("core/2026/07/a.JPG")).toBe(true);
  });
});

describe("variantUrl", () => {
  it("returns the bare file URL when nothing is requested", () => {
    expect(variantUrl(KEY)).toBe(`/api/files/${KEY}`);
    expect(variantUrl(KEY)).toBe(fileUrl(KEY));
  });

  it("emits a snapped width", () => {
    expect(variantUrl(KEY, { width: 500 })).toBe(`/api/files/${KEY}?w=640`);
  });

  it("emits width and format together", () => {
    expect(variantUrl(KEY, { width: 640, format: "avif" })).toBe(
      `/api/files/${KEY}?w=640&f=avif`,
    );
  });

  it("drops an unusable width rather than emitting an empty param", () => {
    expect(variantUrl(KEY, { width: 0 })).toBe(`/api/files/${KEY}`);
  });
});

describe("buildSrcSet", () => {
  it("lists every tier up to the cap", () => {
    expect(buildSrcSet(KEY, 640)).toBe(
      `/api/files/${KEY}?w=320 320w, /api/files/${KEY}?w=640 640w`,
    );
  });

  it("defaults to the full ladder", () => {
    const set = buildSrcSet(KEY);
    expect(set).toBeDefined();
    expect(set!.split(", ")).toHaveLength(VARIANT_WIDTHS.length);
    expect(set).toContain("1920w");
  });

  it("snaps a non-tier cap upward so the requested size is still covered", () => {
    // 版位 400px → 需要 640 那一格才夠 1x 以上,不能只給 320。
    expect(buildSrcSet(KEY, 400)).toContain("640w");
  });

  it("returns undefined for non-transformable keys, so callers omit srcset", () => {
    expect(buildSrcSet("core/2026/07/a.gif")).toBeUndefined();
    expect(buildSrcSet("core/2026/07/a.svg")).toBeUndefined();
    expect(buildSrcSet("core/2026/07/a.pdf")).toBeUndefined();
  });
});

describe("parseVariantRequest", () => {
  const parse = (qs: string) => parseVariantRequest(new URLSearchParams(qs));

  it("returns null when nothing is asked for (= serve the original)", () => {
    expect(parse("")).toBeNull();
    expect(parse("cachebust=1")).toBeNull();
  });

  it("defaults the format when only a width is given", () => {
    expect(parse("w=640")).toEqual({ width: 640, format: DEFAULT_VARIANT_FORMAT });
  });

  it("snaps an arbitrary width into the closed tier list", () => {
    // 這是 cache-key 的保護:任意寬度只能落在五格之一。
    expect(parse("w=333")?.width).toBe(640);
    expect(parse("w=100000")?.width).toBe(1920);
  });

  it("accepts an explicit format", () => {
    expect(parse("w=320&f=avif")).toEqual({ width: 320, format: "avif" });
    // 只給格式 → 不縮放,只轉檔。
    expect(parse("f=png")).toEqual({ format: "png" });
  });

  it("ignores garbage instead of erroring (public serving path)", () => {
    expect(parse("w=abc")).toBeNull();
    expect(parse("w=-10")).toBeNull();
    expect(parse("f=tiff")).toBeNull();
    // 壞 format + 好 width → 仍然轉,用預設格式。
    expect(parse("w=320&f=tiff")).toEqual({
      width: 320,
      format: DEFAULT_VARIANT_FORMAT,
    });
  });
});

describe("variantEtag", () => {
  it("keeps a valid quoted-string shape", () => {
    const tag = variantEtag('"abc123"', { width: 640, format: "webp" });
    expect(tag).toBe('"abc123-640-webp"');
    expect(tag.startsWith('"')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });

  it("gives different variants different validators", () => {
    const a = variantEtag('"abc"', { width: 320, format: "webp" });
    const b = variantEtag('"abc"', { width: 1920, format: "webp" });
    const c = variantEtag('"abc"', { width: 320, format: "avif" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("tracks the source etag, so replacing the original invalidates every variant", () => {
    expect(variantEtag('"v1"', { width: 640 })).not.toBe(
      variantEtag('"v2"', { width: 640 }),
    );
  });
});

describe("FORMAT_CONTENT_TYPE", () => {
  it("maps every format to a real image MIME", () => {
    expect(FORMAT_CONTENT_TYPE.webp).toBe("image/webp");
    expect(FORMAT_CONTENT_TYPE.avif).toBe("image/avif");
    expect(FORMAT_CONTENT_TYPE.jpeg).toBe("image/jpeg");
    expect(FORMAT_CONTENT_TYPE.png).toBe("image/png");
  });
});
