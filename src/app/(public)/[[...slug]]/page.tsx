import type { ComponentType } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicMetadata, PublicViewport } from "@/ext/core-slots";
import { getExtRuntime, type ExtRuntime } from "@/ext/loader";
import { decodePathSegments } from "@/ext/dx/route-matcher";
import { matchPublicRoute, runPublicSteps, type PublicPageRoute, type PublicRouteMatch } from "@/ext/public-pages";
import { getSetting } from "@/lib/settings";

// 2.0:公開頁算一次、整頁存起來(OpenNext 的 R2 增量快取),之後由快取攔截直接回應,
// 不跑 Next server。內容變了由 publicContentChanged()(src/lib/public-cache.ts)讓它們重算。
//
// 四個設定一起才是這個形狀,都是 Next 的標準路由設定:
//   - generateStaticParams 回 [] + dynamicParams:建置時一頁都不算(建置時沒有 D1),每個網址
//     在第一次被造訪時才算並存起來。OpenNext 只攔截這種形狀的動態路由(prerender manifest
//     裡 fallback 是 null)。
//   - revalidate = false:不依時間重算,只在失效時重算(依時間重算要 queue,這裡不用)。
//   - dynamic = "error":頁面、layout、metadata 或任何插件的元件在渲染時讀了 cookies()、headers()、
//     searchParams,就直接報錯,而不是悄悄把整頁變成每次即時算。存起來的頁面對每個訪客都
//     一樣;因人而異的東西(登入狀態、購物車)在頁面出現之後由 client 元件問伺服器(server action
//     或 API route)。什麼時候需要問、怎麼問:src/ext/META.md 的「Public pages」。
//
// 首頁也在這裡(slug 是 undefined):以前 `/` 是同層的 page.tsx,optional catch-all 因此不能用;
// 兩個合成一個,`/` 才能跟其他公開頁一樣被存起來。
//
// 2.x:站台自己的頁面也走這裡,不另開路由檔、不刪這個檔(src/ext/META.md「A site supplies its own public
// pages」):網址與 metadata 是 PublicRoute(接得住 [] 的是首頁,站台的先問),每一頁的 metadata / viewport
// 再流過值的插槽 PublicMetadata / PublicViewport。外框(插槽 PublicFrame)在 (public)/layout.tsx,換頁時不重新
// 掛載;404 是 (public)/not-found.tsx。派送規則在 ext/public-pages.ts。
export const dynamic = "error";
export const dynamicParams = true;
export const revalidate = false;
export function generateStaticParams(): { slug: string[] }[] {
  return [];
}

type Params = Promise<{ slug?: string[] }>;

interface Resolved {
  rt: ExtRuntime;
  /** 解碼後的段;壞掉的 `%` 序列是 null。 */
  segments: string[] | null;
  hit: PublicRouteMatch | null;
}

// 頁面與 metadata 各問一次,同一次渲染裡只算一次(cache 以參數比對,所以傳字串)。
// Next 交來的段是 percent-encoded 的(/news/春季新品 進來是 %E6%98%A5…);所有 matcher 看到的一律是
// 解碼後的字串,中文 slug 才對得上 contents.slug。壞掉的 `%` 序列 → 404(見 decodePathSegments)。
const resolve = cache(async (key: string): Promise<Resolved> => {
  const rt = await getExtRuntime();
  const segments = decodePathSegments(JSON.parse(key) as string[]);
  return { rt, segments, hit: segments ? matchPublicRoute(rt.enabled, segments) : null };
});

const resolveParams = async (params: Params) => resolve(JSON.stringify((await params).slug ?? []));

function routeOf({ segments, hit }: Resolved): PublicPageRoute {
  if (segments && hit) return segments.length === 0 ? { kind: "home", path: segments, ext: hit.ext.id } : { kind: "page", path: segments, ext: hit.ext.id };
  if (segments && segments.length === 0) return { kind: "home", path: segments, ext: null };
  return { kind: "not-found", path: segments, ext: null };
}

// route 沒給 metadata、也沒有人填 PublicMetadata = 回 {}:head 跟沒有這個函式時一樣。
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const resolved = await resolveParams(params);
  const { rt, hit } = resolved;
  const base = hit?.route.metadata ? await hit.route.metadata(hit.params) : {};
  return runPublicSteps(base, rt.slots.value(PublicMetadata, []), { route: routeOf(resolved) });
}

export async function generateViewport({ params }: { params: Params }): Promise<Viewport> {
  const resolved = await resolveParams(params);
  return runPublicSteps<Viewport, { route: PublicPageRoute }>({}, resolved.rt.slots.value(PublicViewport, []), { route: routeOf(resolved) });
}

export default async function PublicPage({ params }: { params: Params }) {
  const resolved = await resolveParams(params);
  assertNoRetryableFailure(resolved.rt);
  const { segments, hit } = resolved;
  if (!segments) notFound();
  if (hit) {
    const C = hit.route.component;
    return <C params={hit.params} />;
  }
  if (segments.length === 0) return <HomePage />;
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

// 03 §6:沒有 route 接首頁時,用 filter:publicHome 取得要渲染的 component,
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
