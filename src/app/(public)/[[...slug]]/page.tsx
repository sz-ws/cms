import type { ComponentType } from "react";
import { notFound } from "next/navigation";
import { getExtRuntime, type ExtRuntime } from "@/ext/loader";
import { decodePathSegments } from "@/ext/dx/route-matcher";
import { getSetting } from "@/lib/settings";

// 2.0:公開頁算一次、整頁存起來(OpenNext 的 R2 增量快取),之後由快取攔截直接回應,
// 不跑 Next server。內容變了由 publicContentChanged()(src/lib/public-cache.ts)讓它們重算。
//
// 四個設定一起才是這個形狀,都是 Next 的標準路由設定:
//   - generateStaticParams 回 [] + dynamicParams:建置時一頁都不算(建置時沒有 D1),每個網址
//     在第一次被造訪時才算並存起來。OpenNext 只攔截這種形狀的動態路由(prerender manifest
//     裡 fallback 是 null)。
//   - revalidate = false:不依時間重算,只在失效時重算(依時間重算要 queue,這裡不用)。
//   - dynamic = "error":頁面、layout 或任何插件的元件在渲染時讀了 cookies()、headers()、
//     searchParams,就直接報錯,而不是悄悄把整頁變成每次即時算。存起來的頁面對每個訪客都
//     一樣;因人而異的東西(登入狀態、購物車)在頁面出現之後由 client 元件問伺服器(server action
//     或 API route)。什麼時候需要問、怎麼問:src/ext/META.md 的「Public pages」。
//
// 首頁也在這裡(slug 是 undefined):以前 `/` 是同層的 page.tsx,optional catch-all 因此不能用;
// 兩個合成一個,`/` 才能跟其他公開頁一樣被存起來。
export const dynamic = "error";
export const dynamicParams = true;
export const revalidate = false;
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}

// OG image metadata: declarative extensions that declare `og.image.template` are
// expected to provide their own `generateMetadata()` within an extension-specific
// route file (or via a future adaptive metadata middleware). The
// `/api/og/<extId>/<type>` endpoint itself is generic and stays in this file.
export default async function PublicPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const rt = await getExtRuntime();
  assertNoRetryableFailure(rt);
  if (!slug || slug.length === 0) return <HomePage />;
  // Next 交來的段是 percent-encoded 的(/news/春季新品 進來是 %E6%98%A5…);所有
  // matcher 看到的一律是解碼後的字串,中文 slug 才對得上 contents.slug。壞掉的
  // `%` 序列 → 404(見 decodePathSegments)。
  const segments = decodePathSegments(slug);
  if (!segments) notFound();
  for (const ext of rt.enabled)
    for (const route of ext.publicRoutes ?? []) {
      const m = route.match(segments);
      if (m) {
        const C = route.component;
        return <C params={m} />;
      }
    }
  notFound();
}

// 插件的 migration 這次沒跑成(多半是 D1 一時出錯),loader 這一次先不載入它、下一個請求再試。
// 少了一個插件的頁面(它的路由變 404、首頁或頁首少一塊)不能存起來:存了就一直是那樣,直到下一次
// 失效。這裡丟錯,這次是 500,Next 不存;下一位訪客再算一次。
function assertNoRetryableFailure(rt: ExtRuntime): void {
  for (const [id, issue] of rt.unavailableById) {
    if (issue.kind === "migration-failed") {
      throw new Error(`[public] plugin "${id}" is unavailable this request (migration failed); this page is not stored`);
    }
  }
}

// 03 §6:首頁用 filter:publicHome 取得要渲染的 component,
// 無則顯示內建的極簡歡迎頁(站名 + 描述,來自 settings)。
async function HomePage() {
  const rt = await getExtRuntime();
  const home = await rt.hooks.applyFilters<ComponentType | null>(
    "filter:publicHome",
    null,
  );

  if (home) {
    const C = home;
    return <C />;
  }

  const siteTitle = await getSetting<string>("core.siteTitle", "My Site");
  const siteDescription = await getSetting<string>("core.siteDescription", "");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-3 px-6 py-16">
      <h1 className="text-3xl font-semibold text-gray-900">{siteTitle}</h1>
      {siteDescription && (
        <p className="text-base text-gray-600">{siteDescription}</p>
      )}
    </main>
  );
}
