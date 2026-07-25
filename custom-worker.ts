import openNextHandler from "./.open-next/worker.js";
import { runCronTick } from "./extensions/cron/scheduled";

// Worker 入口(wrangler.jsonc 的 `main`)—— OpenNext 產出的 handler 再包一層。
//
// 為什麼要包:`@opennextjs/cloudflare` 產生的 `.open-next/worker.js` 只
// `export default { fetch }`,沒有 `scheduled`。但它的 CLI 完全不讀、不驗證、不覆寫
// wrangler 的 `main` 欄位(已讀原始碼確認),所以把 `main` 指到這個檔、由它 re-export
// 產出物的 fetch,是乾淨可行的:OpenNext 的輸出一個 byte 都沒被改動。
//
// `export *` 把產出物的 Durable Object class(DOQueueHandler / DOShardedTagCache /
// BucketCachePurge)原樣往外傳 —— 少了它們,將來在 wrangler.jsonc 加 DO binding 會
// 找不到 class。default export 不在 `export *` 的範圍內,所以下面另外組一個。
export * from "./.open-next/worker.js";

const worker = {
  fetch: openNextHandler.fetch,

  // 分鐘級準時排程的「錶」。實作在 extensions/cron/scheduled.ts —— core 本身
  // 永遠只有 lazy sweep,secret 與 tick 入口都屬於 cron extension(見該檔註解)。
  // scheduled 沒有 request context,不能碰 getCloudflareContext();env 由此處直接傳入。
  // runCronTick 絕不 throw:cron 沒裝/沒啟用/沒設密鑰都是安靜 no-op。
  async scheduled(
    _event: ScheduledController,
    env: CloudflareEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCronTick(env));
  },
};

export default worker;
