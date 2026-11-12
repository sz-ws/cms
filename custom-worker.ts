import openNextHandler from "./.open-next/worker.js";
import { createWorker } from "./worker/create-worker";

// Worker 入口(wrangler.jsonc 的 `main`)—— OpenNext 產出的 handler 再包一層。
//
// 為什麼要包:`@opennextjs/cloudflare` 產生的 `.open-next/worker.js` 只
// `export default { fetch }`,沒有 `scheduled`。但它的 CLI 完全不讀、不驗證、不覆寫
// wrangler 的 `main` 欄位(已讀原始碼確認),所以把 `main` 指到這個檔、由它 re-export
// 產出物的 fetch,是乾淨可行的:OpenNext 的輸出一個 byte 都沒被改動。
//
// 包在外面的 fetch 與 scheduled 寫在 worker/create-worker.ts,選用的拆分入口
// (worker/split-entry.ts)也用同一份。這是 cms 的預設入口:整個 Next server 打包成同一個模組,
// 不需要任何相容旗標。
//
// `export *` 把產出物的 Durable Object class(DOQueueHandler / DOShardedTagCache /
// BucketCachePurge)原樣往外傳 —— 少了它們,將來在 wrangler.jsonc 加 DO binding 會
// 找不到 class。default export 不在 `export *` 的範圍內,所以下面另外組一個。
export * from "./.open-next/worker.js";

export default createWorker(openNextHandler);
