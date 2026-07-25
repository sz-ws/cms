import { unstable_cache } from "next/cache";
import { eq } from "drizzle-orm";
import { getContentProvider } from "./runtime";
import { contentTag, extTag } from "./cache-tags";
import { db } from "../../lib/db";
import { declarativeExtensions } from "../../lib/schema";
import type { ContentEntry, ContentQuery } from "../capabilities";

// core-v2:public 匿名路徑(catch-all [...slug] → ListView / DetailView)的 content 讀取
// 快取。只快取 rows(ContentEntry —— 純可序列化物件),「不」快取 interpreted Extension
// 或 provider 實例。每筆快取條目掛兩個 tag:
//   content:<extId>.<typeName>  —— type-scoped(content mutation 精準失效)
//   ext:<extId>                 —— ext-scoped(install/enable/disable 整批失效)
//
// cache API 選擇:next/cache 的 unstable_cache({ tags })。已安裝 next 16.2.10 未開啟
// dynamicIO / useCache 的 experimental flag,故 `"use cache"` + cacheTag 不可用;
// unstable_cache 為 `next dev` 與 OpenNext build 兩端皆支援的穩定基準,是本專案唯一
// 可靠選項。任何 cache 例外(scope 問題、序列化)一律降級為直查 provider,永不讓
// 讀取路徑因 cache plumbing 而壞掉(見各函式 catch)。
//
// admin 路徑(CollectionView / FormViewPage / SubmissionsView)刻意「不」走此模組 ——
// 後台需要即時、未快取的資料;只有 public 匿名 view 讀取進快取。

/** public list view 的分頁查詢(ListView)。type = "<extId>.<typeName>"。 */
export async function cachedPublicQuery(
  extId: string,
  type: string,
  q: ContentQuery,
): Promise<{ items: ContentEntry[]; total: number }> {
  try {
    const run = unstable_cache(
      async () => {
        const provider = await getContentProvider();
        return provider.query(type, q);
      },
      // keyParts:同一 (type, query) 命中同一條目;不同 query 各自快取。
      ["dx-content-query", type, JSON.stringify(q)],
      { tags: [contentTag(type), extTag(extId)] },
    );
    return await run();
  } catch (err) {
    console.error(`[dx:cache] cachedPublicQuery fell back to direct read type=${type}`, err);
    const provider = await getContentProvider();
    return provider.query(type, q);
  }
}

/** public detail view 依 slug 取單筆(DetailView)。type = "<extId>.<typeName>"。 */
export async function cachedPublicGetBySlug(
  extId: string,
  type: string,
  slug: string,
  // migrations/0011:locale **必須**進快取鍵。少了它,unstable_cache 會把第一個被
  // 請求的語言供應給之後所有訪客 —— dev 單語看不出來,production 是「訪客拿到錯的
  // 語言」的事故。省略 = 不限語言(維持舊行為),此時鍵值用 "*" 標示。
  locale?: string,
): Promise<ContentEntry | null> {
  try {
    const run = unstable_cache(
      async () => {
        const provider = await getContentProvider();
        return provider.getBySlug(type, slug, locale);
      },
      ["dx-content-getBySlug", type, slug, locale ?? "*"],
      { tags: [contentTag(type), extTag(extId)] },
    );
    return await run();
  } catch (err) {
    console.error(
      `[dx:cache] cachedPublicGetBySlug fell back to direct read type=${type} slug=${slug}`,
      err,
    );
    const provider = await getContentProvider();
    return provider.getBySlug(type, slug, locale);
  }
}

/**
 * 1.8.0:讀取某 extension 已驗證的 co-located stylesheet(declarative_extensions.stylesheet)。
 * 走與 content 讀取相同的 tagged cache(tag ext:<extId>)—— install/update 後 revalidateExt
 * 會一併失效此快取,故 re-install 帶新 CSS 立即生效。無 sheet → null。
 *
 * 任何 cache/DB 例外一律降級為「無 sheet」(回 null)並 console.error —— 絕不讓
 * 樣式讀取失敗連累 public 頁面渲染(降級成無自訂樣式,見 theme-scope 注入端)。
 */
export async function cachedExtStylesheet(extId: string): Promise<string | null> {
  try {
    const run = unstable_cache(
      async () => {
        const rows = await db()
          .select({ stylesheet: declarativeExtensions.stylesheet })
          .from(declarativeExtensions)
          .where(eq(declarativeExtensions.id, extId))
          .limit(1);
        return rows[0]?.stylesheet ?? null;
      },
      ["dx-ext-stylesheet", extId],
      { tags: [extTag(extId)] },
    );
    return await run();
  } catch (err) {
    console.error(
      `[dx:cache] cachedExtStylesheet fell back to no-stylesheet extId=${extId}`,
      err,
    );
    return null;
  }
}
