import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 整個網站最後一道錯誤邊界(src/app/global-error.tsx)的第一個畫面:要不到 chunk 的錯先畫「重新整理中」
// (接著自動重新整理,見 chunk-reload.test.ts),其他錯直接畫錯誤畫面。畫面本身是站台的
// (src/app/site-error.tsx,每個站不一樣),這裡換成一個只印出 props 的替身 —— 這個測試在每個站都原樣能跑。
// 伺服器上畫的跟瀏覽器第一次畫的要一樣,所以 renderToStaticMarkup 看第一個畫面就夠。

vi.mock("@/app/site-error", () => ({
  SITE_ERROR_LANG: "xx-Test",
  SiteError: ({ reloading }: { reloading: boolean }) => createElement("p", null, reloading ? "site:reloading" : "site:error"),
}));

const { default: GlobalError } = await import("@/app/global-error");

function render(error: Error) {
  return renderToStaticMarkup(createElement(GlobalError, { error }));
}

describe("GlobalError", () => {
  it("asks the site for its reloading screen when a chunk will not load", () => {
    const error = new Error("Loading chunk 6576 failed.");
    error.name = "ChunkLoadError";
    expect(render(error)).toContain("site:reloading");
  });

  it("asks the site for its error screen for any other error", () => {
    expect(render(new TypeError("Cannot read properties of undefined (reading 'map')"))).toContain("site:error");
  });

  it("replaces the whole document in the site's error-screen language", () => {
    expect(render(new Error("boom"))).toMatch(/^<html lang="xx-Test">/);
  });
});
