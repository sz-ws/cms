// ⚠️ 建置必須走 **webpack**,不是 Turbopack。package.json 的 `build` script 因此
// 釘死 `next build --webpack`(Next 16 的 `next build` 預設是 Turbopack)。
//
// 為什麼:Turbopack 的產出裡沒有 `.next/server/instrumentation.js`,而
// @opennextjs/aws 的 copyTracedFiles 會去找它,找不到就整個 build 掛掉:
//
//   Error: This error should only happen for static 404 and 500 page from page router.
//           File server/instrumentation.js does not exist
//
// (訊息完全指不到真因 —— 它講的是 pages router 的 404/500,而我們用 app router。)
// 這個專案有 instrumentation.ts(Sentry 的 onRequestError,見 src/lib/observe/),
// 所以一定會走到那條路徑。@opennextjs/aws 4.0.2 + Next 16.2.10 實測會炸,
// 換成 --webpack 就過。哪天 OpenNext 支援 Turbopack 產出了再回頭拿掉這個旗標。

import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";

// incrementalCache(既有):ISR/data cache 的實體 payload 存 R2(NEXT_INC_CACHE_R2_BUCKET)。
// tagCache(1.8.0 新增):on-demand revalidateTag 的 tag→revalidatedAt 記錄存 D1
// (binding NEXT_TAG_CACHE_D1,table `revalidations`)。public declarative content 的
// tagged data cache(見 src/ext/dx/content-cache.ts)在 production 靠此 override 生效:
// content mutation / ext install·enable·disable 呼叫 revalidateTag 後,worker 各 isolate
// 讀 D1 判斷 tag 是否已失效。dev(`next dev`)走 Next 內建 handler,不需此 override。
//
// 部署前置:必須先 `wrangler d1 create cms-tag-cache`,並把真實 database_id 換進
// wrangler.jsonc 的第二個 d1_databases 項。`revalidations` 表本身不需要手動建 ——
// `opennextjs-cloudflare deploy` 會先跑 populate-cache,由它 CREATE TABLE IF NOT
// EXISTS(該 schema 由 OpenNext 擁有,v1.19 加過 stale/expire 欄位)。見 DEPLOY.md。
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
});
