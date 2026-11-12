import { describe, expect, it } from "vitest";

// 2.0 頁面快取的路由形狀(設計 A1)寫成測試,不再是註解裡的規矩:
//   - src/app/(public) 底下的每一個 page.tsx 都是「第一次造訪才算、整頁存起來」的那種:
//     dynamic = "error"、dynamicParams = true、revalidate = false、generateStaticParams 回 []。
//     少了任何一個,不是建置時去讀不存在的 D1,就是整頁悄悄變回每次即時算。
//   - 從根到 (public) 的 layout 不得改路由設定(dynamic / revalidate / fetchCache):layout 的設定
//     會蓋過或混進頁面的。
//   - (public) 底下的檔案不讀請求(next/headers):存起來的 HTML 對每個訪客都一樣。讀了的話,
//     dynamic = "error" 會讓那一頁在第一次造訪時直接報錯。
// workerd 裡沒有檔案系統,原始碼由 vite 在建置測試時以 ?raw 內嵌(同 migration-parity.test.ts)。

const sources = import.meta.glob("../src/app/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const file = (suffix: string) => {
  const hit = Object.entries(sources).find(([path]) => path.endsWith(suffix));
  if (!hit) throw new Error(`missing ${suffix}`);
  return hit[1];
};

const PUBLIC = "/src/app/(public)/";
const publicFiles = Object.entries(sources).filter(([path]) => path.includes(PUBLIC));
const publicPages = publicFiles.filter(([path]) => path.endsWith("/page.tsx"));

describe("cacheable public routes keep the A1 exports", () => {
  it("the public pages are exactly the one optional catch-all", () => {
    expect(publicPages.map(([path]) => path.slice(path.indexOf(PUBLIC)))).toEqual([
      "/src/app/(public)/[[...slug]]/page.tsx",
    ]);
  });

  it.each(publicPages)("%s renders on first visit, is stored, and refuses request data", (_path, source) => {
    expect(source).toMatch(/^export const dynamic = "error";$/m);
    expect(source).toMatch(/^export const dynamicParams = true;$/m);
    expect(source).toMatch(/^export const revalidate = false;$/m);
    // 函式本體只有 `return [];`(回傳型別可以寫,例如 `: { slug: string[] }[]`)。
    expect(source).toMatch(/^export (async )?function generateStaticParams\(\)[^\n]*\{\n\s*return \[\];\n\}$/m);
  });

  it("no layout above the public pages changes their route settings", () => {
    for (const layout of [file("/src/app/layout.tsx"), file("/src/app/(public)/layout.tsx")]) {
      expect(layout).not.toMatch(/^export const (dynamic|revalidate|fetchCache|dynamicParams)\b/m);
    }
  });

  it("nothing under (public) reads the request", () => {
    for (const [path, source] of publicFiles) {
      expect(source, path).not.toMatch(/from ["']next\/headers["']/);
    }
  });
});
