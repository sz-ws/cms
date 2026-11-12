import { describe, expect, it } from "vitest";
import { draftPreviewHref } from "../src/ext/dx/preview-link";

// 2.0:草稿的編輯頁有一個「預覽草稿」連結,經 /api/preview 打開 Next 的 draft mode,轉到那一篇
// 在網站上的網址。只有草稿、有網址(這個型別有公開的單篇頁、這一篇有 slug)時才有。

const ROUTES = [
  { pattern: "/blog", view: "list", contentType: "post" },
  { pattern: "/blog/:slug", view: "detail", contentType: "post" },
  { pattern: "/contact", view: "form", contentType: "message" },
];

describe("draft preview link", () => {
  it("points a draft at its public address through /api/preview", () => {
    expect(draftPreviewHref(ROUTES, "post", { status: "draft", slug: "hello" })).toBe(
      "/api/preview?path=%2Fblog%2Fhello",
    );
  });

  it("encodes a Chinese slug the same way the public links do", () => {
    expect(draftPreviewHref(ROUTES, "post", { status: "draft", slug: "春季新品" })).toBe(
      `/api/preview?path=${encodeURIComponent(`/blog/${encodeURIComponent("春季新品")}`)}`,
    );
  });

  it("is absent for published entries, entries without a slug and types without a detail page", () => {
    expect(draftPreviewHref(ROUTES, "post", { status: "published", slug: "hello" })).toBeNull();
    expect(draftPreviewHref(ROUTES, "post", { status: "draft", slug: null })).toBeNull();
    expect(draftPreviewHref(ROUTES, "message", { status: "draft", slug: "x" })).toBeNull();
    expect(draftPreviewHref(undefined, "post", { status: "draft", slug: "hello" })).toBeNull();
  });
});
