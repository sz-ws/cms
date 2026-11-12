import openNextHandler from "../.open-next/split/worker.js";
import { createWorker } from "./create-worker";

// 選用的 Worker 入口:跟 custom-worker.ts 是同一個 Worker(同一個 fetch、scheduled、Durable Object
// class),差別在 Next server 怎麼載入。預設入口把整個 server 打包進主模組,isolate 啟動時整包編譯;
// 這個入口載入 scripts/split-server-chunks.mjs 拆好的 `.open-next/split/worker.js`,server 是另外上傳的
// 模組,每個 webpack chunk 與路由檔也各自是一個模組,第一次用到才編譯。只跑 middleware 的請求
// 完全不碰 server。
//
// 必要條件(缺一個就不能用,詳見 README.md):
// - wrangler.jsonc 的 compatibility_flags 有 "new_module_registry":舊的模組機制在啟動時編譯所有
//   上傳的模組,而且 server 模組裡的 import.meta.url 是 undefined。
// - 每次 `opennextjs-cloudflare build` 之後先跑 scripts/split-server-chunks.mjs(package.json 的
//   preview / deploy 已經接好)。
// - wrangler.jsonc 的 find_additional_modules、rules、base_dir 讓 wrangler 把 .open-next/split/server/
//   底下的模組原樣上傳。
//
// 要退回,把 wrangler.jsonc 的 `main` 改回 "custom-worker.ts";旗標與那三個欄位留著也無害。
//
// `export *` 把 Durable Object class 往外傳,wrangler 要在 `main` 上找到它們;default export 不在
// `export *` 的範圍內,所以另外組一個。
export * from "../.open-next/split/worker.js";

export default createWorker(openNextHandler);
