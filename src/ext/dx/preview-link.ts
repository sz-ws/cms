import { detailPath } from "./route-matcher";

// 2.0 草稿預覽的入口:草稿的編輯頁上「預覽草稿」連結的網址。經 /api/preview 打開 Next 的
// draft mode(只對這位編輯),轉到這一篇在網站上的網址;那一次逐請求渲染、草稿照樣顯示,
// 不會存起來給訪客。純函式:只看 manifest 的公開路由與這一篇的狀態和 slug。

interface PublicRouteLike {
  pattern: string;
  view: string;
  contentType: string;
}

/**
 * 草稿、有 slug、這個型別有公開的單篇頁(detail route)→ `/api/preview?path=…`;其他一律 null
 * (已發佈的直接看網站就好;沒有網址的草稿沒有東西可以預覽)。
 */
export function draftPreviewHref(
  publicRoutes: readonly PublicRouteLike[] | undefined,
  typeName: string,
  entry: { status: string; slug?: string | null },
): string | null {
  if (entry.status !== "draft" || !entry.slug) return null;
  const detail = (publicRoutes ?? []).find((r) => r.contentType === typeName && r.view === "detail");
  if (!detail) return null;
  const segments = detail.pattern.split("/").filter((s) => s.length > 0);
  segments.pop(); // 去掉 :slug 段
  return `/api/preview?path=${encodeURIComponent(detailPath(`/${segments.join("/")}`, entry.slug))}`;
}
