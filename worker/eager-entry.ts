// 選用的 Worker 入口:跟 custom-worker.ts 是同一個 Worker(同一個 fetch、scheduled、Durable Object
// class),只多一件事 —— Next 伺服器在 isolate 啟動時就建好,不等第一個請求(見 eager-startup.mjs)。
//
// cms 的預設入口仍是 custom-worker.ts。要選用的站,把 wrangler.jsonc 的 `main` 改成
// "worker/eager-entry.ts";要退回,改回 "custom-worker.ts"。兩個入口回應的內容一樣,差在時間花在哪裡:
//
// - 什麼時候值得開:訪客常打到冷的 isolate(流量不大、或部署頻繁)。OpenNext 原本在第一個請求裡建
//   Next 伺服器,冷的 isolate 上哪一條路由的第一個訪客都要多等這一段;開了之後這段改在啟動時跑完,
//   不算進任何請求。
// - 代價:啟動變長,而 Cloudflare 的啟動上限是 1 秒。超過的話 `wrangler deploy` 直接失敗、線上照舊
//   跑舊版本,不會有壞掉的版本上線;所以開之前先照 README.md 的方法量一次啟動時間。
//
// 載入順序是刻意的:先載入 custom-worker(連同 worker.js 帶進來的 middleware 與我們自己的模組),它們
// 照舊在原生的 fetch / Request 下求值;再載入 eager-startup.mjs,它換掉 fetch / Request 後才建 Next
// 伺服器。兩行對調的話,middleware 會改在替換過的全域下求值,跟 OpenNext 平常的順序不一樣。
//
// `export *` 把 custom-worker 的具名匯出原樣往外傳,其中包括它自己 `export *` 轉出來的 Durable Object
// class(DOQueueHandler / DOShardedTagCache / BucketCachePurge)—— wrangler 要在 `main` 上找到它們。
// default export 不在 `export *` 的範圍內,所以另外轉一次。
import worker from "../custom-worker";
import "./eager-startup.mjs";

export * from "../custom-worker";
export default worker;
