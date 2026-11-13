import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import type { SiteNoticeWindow } from "@/lib/site-notice";
import { layerRank } from "./slots";
import type { Extension, PublicRoute } from "./types";

// 公開頁:站台(或代理商、插件)怎麼提供自己的頁面,全部經 core 那一個存起來的路由
// (src/app/(public)/[[...slug]]/page.tsx)。說明見 src/ext/META.md「A site supplies its own public pages」。
//
//   - 網址:PublicRoute(types.ts)。接得住 [] 的是首頁。先問哪一個插件照層:站台、代理商、一般插件;
//     同一層照載入順序。matchPublicRoute() 是唯一的派送規則,頁面與它的 metadata 都用它。
//   - metadata:route 自己的 metadata(params),再依序流過值的插槽 PublicMetadata 的每一步(core-slots.ts)。
//     viewport 同樣走 PublicViewport。
//   - 外框:畫面的插槽 PublicFrame(core-slots.ts),由 (public)/layout.tsx 畫,換頁時不重新掛載。layout 不知道
//     網址,所以外框只拿到網站公告與這一頁;照網址換樣子的在 client 元件裡用 usePathname()。
//     預設是 1.x 起的樣子:公告列、filter:publicHeader、內容、filter:publicFooter(components/PublicFrame.tsx)。
//   - 404:(public)/not-found.tsx,在外框裡,內容是畫面的插槽 PublicNotFound。
//
// 這些都在「存起來的那一次渲染」裡跑:不讀 cookies()、headers()、searchParams(路由是 dynamic = "error",
// 讀了就是一個 500,不會悄悄變成每次即時算)。

/** 這一頁是哪一種、哪個網址、哪個插件接的。metadata / viewport 的每一步都拿到它(外框拿不到:它在 layout 裡)。 */
export type PublicPageRoute =
  /** 首頁。ext:接住空路徑的插件;null = filter:publicHome 或內建的歡迎頁。 */
  | { kind: "home"; path: readonly string[]; ext: string | null }
  /** 其他接得住的網址。path 是解碼後的段。 */
  | { kind: "page"; path: readonly string[]; ext: string }
  /**
   * 沒有 route 接的網址,或壞掉的 `%` 序列(path 是 null)。route 接住了、自己 notFound() 的頁照樣是 "page"。
   * 這一步給的 title 在 404 上只在頁面載入後才換上(Next 把 404 的 metadata 放在 payload 裡;HTML 的 <head>
   * 是站名加 noindex)。
   */
  | { kind: "not-found"; path: readonly string[] | null; ext: null };

/**
 * 外框拿到的。children 是這一頁(或 404 的內容)。沒有網址:外框在 layout 裡,layout 不知道網址;
 * 照網址換樣子的外框在 client 元件裡用 usePathname()(client 元件也在伺服器上畫,存起來的 HTML 已經是對的樣子)。
 */
export interface PublicFrameProps {
  /** 網站公告(設定 → 網站公告);沒開是 null。有日期的公告由瀏覽器決定出不出現(lib/site-notice.ts)。 */
  notice: SiteNoticeWindow | null;
  children: ReactNode;
}

/**
 * PublicMetadata 的一步:拿到目前的 metadata(先是 route 自己的,沒有就是 {}),回傳新的。
 * 可以 async(例如讀設定)。丟錯的話這一次是 500、不存 —— 少了 metadata 的頁面不能被存起來。
 */
export type PublicMetadataStep = (metadata: Metadata, ctx: { route: PublicPageRoute }) => Metadata | Promise<Metadata>;

/** PublicViewport 的一步(themeColor 之類),規矩同 PublicMetadataStep。 */
export type PublicViewportStep = (viewport: Viewport, ctx: { route: PublicPageRoute }) => Viewport | Promise<Viewport>;

export interface PublicRouteMatch {
  ext: Pick<Extension, "id" | "layer">;
  route: PublicRoute;
  params: Record<string, string>;
}

/** 照層由高到低(站台、代理商、一般插件),同一層保持原本的順序。 */
export function publicRouteOrder<E extends Pick<Extension, "layer">>(extensions: readonly E[]): E[] {
  return extensions
    .map((ext, index) => ({ ext, index }))
    .sort((a, b) => layerRank(b.ext.layer) - layerRank(a.ext.layer) || a.index - b.index)
    .map(({ ext }) => ext);
}

/** 這個網址由誰接;沒有人接是 null。segments 是解碼後的段,首頁是 []。 */
export function matchPublicRoute(
  extensions: readonly Pick<Extension, "id" | "layer" | "publicRoutes">[],
  segments: readonly string[],
): PublicRouteMatch | null {
  for (const ext of publicRouteOrder(extensions))
    for (const route of ext.publicRoutes ?? []) {
      const params = route.match([...segments]);
      if (params) return { ext, route, params };
    }
  return null;
}

/** 照順序跑每一步;丟錯就往上丟(這一次 500、不存)。 */
export async function runPublicSteps<T, C>(base: T, steps: readonly ((value: T, ctx: C) => T | Promise<T>)[], ctx: C): Promise<T> {
  let value = base;
  for (const step of steps) value = await step(value, ctx);
  return value;
}
