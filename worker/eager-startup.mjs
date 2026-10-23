// Next 伺服器在 isolate 啟動時就建好,不等第一個請求。只有選用 worker/eager-entry.ts 當入口的站會載入這個檔
// (wrangler.jsonc 的 `main`;cms 預設的入口 custom-worker.ts 不載入它),時機是 custom-worker 求值完之後。
// 何時該選用、怎麼量,見同資料夾的 README.md。
//
// ## 為什麼
//
// OpenNext 產出的 `.open-next/worker.js` 在 `fetch` 裡面才
// `await import("./server-functions/default/handler.mjs")`,而 handler.mjs 的最上層會
// `await createMainHandler()`:讀 manifest、`new NextServer`、裝快取 override。冷的 isolate 上,這一整段
// 算在第一個訪客的請求裡,哪一條路由都一樣(正式站冷請求 500–900 ms CPU,熱的 20–60 ms)。這個檔在
// 全域範圍 `await import` 同一個模組,初始化就改在 isolate 啟動時跑完:不算進任何一個請求的 CPU,而且
// workerd 會把啟動時編譯好的模組做 code cache。wrangler 打包時兩個 import 指向同一個只初始化一次的模組
// (esbuild 的 `init_handler()`),所以 fetch 裡那次動態 import 直接拿到已經建好的伺服器,不會再做一次。
//
// ## 為什麼要先換掉 fetch 與 Request
//
// OpenNext 刻意等到 fetch 才載入 handler.mjs:先跑 `.open-next/cloudflare/init.js` 的 `init()`(每個
// isolate 一次),再讓 Next 的模組求值。`init()` 會把 `globalThis.fetch` 換成丟掉 `cache` 選項的版本、把
// `globalThis.Request` 換成會把 Node stream body 轉成 ReadableStream 的子類別,再設幾個建置常數與
// process.env 裡的網址。提早求值的話,handler.mjs 裡在最上層寫死 `class X extends Request` 的模組
// (實測:next/dist/server/web/spec-extension/request.js 的 NextRequest)會接到 workerd 原生的 Request。
// 所以這裡先做 init() 裡跟請求無關的那兩個替換,程式照抄 OpenNext 的 initRuntime;handler.mjs 求值時看到
// 的 fetch 與 Request,就跟原本在第一個請求裡求值時一樣。
//
// 其餘的照舊交給 OpenNext:第一個請求進來時 init() 照常跑(它的 `initialized` 旗標我們沒碰),設建置常數、
// process.env 的 OPEN_NEXT_ORIGIN / __NEXT_PRIVATE_ORIGIN(要用請求的網址,啟動時還不知道)。2026-10-23
// 在本機 workerd 上逐一攔截量過:handler.mjs 啟動時讀到的全域只有 Request、fetch 與 __dirname,process.env
// 只讀 Next 自己的 NEXT_* 開關(init() 不會設的那些;綁定的字串值 workerd 啟動時就放進 process.env 了),
// 建置常數與那兩個網址一個都沒讀。init() 會在我們的替換外面再包一層:fetch 多刪一次 `cache`、Request 多
// 轉一次 body(已經是 ReadableStream 就原樣),結果相同。
//
// 只在這個檔做替換、而且 eager-entry.ts 先載入 custom-worker 才載入這個檔:middleware(worker.js 靜態載入)
// 與我們自己的模組照舊在原生的 fetch / Request 下求值,跟以前一樣;只有 Next 伺服器這一段提早了。
// 要退回舊行為,把 wrangler.jsonc 的 `main` 改回 custom-worker.ts 就好。
//
// 下面兩個替換照抄 @opennextjs/cloudflare 1.20.x 產出的 `.open-next/cloudflare/init.js` 裡的 `initRuntime`。
// 每次升級 OpenNext 都要拿新版的 init.js 對照一次:initRuntime 多換了什麼全域、或 handler.mjs 改成在最上層
// 讀建置常數,這裡就要跟著改(或乾脆退回 custom-worker.ts)。
//
// ## 代價與護欄
//
// 啟動變長。Cloudflare 的啟動上限是 1 秒;全域範圍裡也不准做 I/O、計時器這類事。超過上限、或哪天 OpenNext
// 的初始化在全域範圍做了不准做的事,`wrangler deploy` 會直接失敗、線上照舊跑舊版本 —— 那次失敗的部署就是
// 護欄,不會有壞掉的版本上線。本機量法(先跑過 `opennextjs-cloudflare build`):
//
//   pnpm exec wrangler deploy --dry-run --outfile x.bundle --compatibility-date 2026-05-03
//   pnpm exec wrangler check startup --worker x.bundle
//
// 第二行寫出啟動階段的 CPU profile(本機 CPU,只看相對變化)。2026-10-23 本機 workerd、同一份建置量到:
// 啟動 200–230 → 230–270 ms;冷請求 `/` 430–470 → 320–380 ms、`/api/csp-report` 350 → 190 ms;熱請求不變。
//
// ## 為什麼是 .mjs
//
// 旁邊的 eager-startup.d.mts 讓 tsc 停在這個檔。寫成 .ts 的話,tsc(allowJs)會順著 import 把
// 16 MB 的 handler.mjs 整個載進型別程式:建置過的工作目錄裡每次 tsc 與編輯器多 1.5 GB 記憶體、十幾秒。
import stream from "node:stream";

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (init) {
    delete init.cache;
  }
  return originalFetch(input, init);
};

globalThis.Request = class extends globalThis.Request {
  constructor(input, init) {
    if (init) {
      delete init.cache;
      Object.defineProperty(init, "body", {
        value: init.body instanceof stream.Readable ? ReadableStream.from(init.body) : init.body,
      });
    }
    super(input, init);
  }
};

await import("../.open-next/server-functions/default/handler.mjs");
