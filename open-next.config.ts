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
// 部署前置(見 docs/handoff-notes.md「Tag cache (D1) 部署步驟」):必須先 `wrangler d1
// create` 出 tag DB、建 `revalidations` 表,並把真實 database_id 換進 wrangler.jsonc。
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
});
