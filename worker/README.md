# worker/ — Worker 入口的共用部分與選用的拆分入口

## 檔案

| 檔案 | 用途 |
|---|---|
| `create-worker.ts` | 兩個入口共用的 `fetch` 與 `scheduled`(請求範圍、Server-Timing、cron tick)。只寫在這裡一次 |
| `split-entry.ts` | 選用的入口:載入拆分後的 `.open-next/split/worker.js`,Next server 用到才逐塊編譯 |

cms 的預設入口是 repo 根目錄的 `custom-worker.ts`:整個 Next server 打包進主模組,不需要任何相容旗標。
`split-entry.ts` 只在 `wrangler.jsonc` 的 `main` 指到它時才會被打包。

相關的建置腳本:

| 檔案 | 用途 |
|---|---|
| `scripts/split-server-chunks.mjs` | `opennextjs-cloudflare build` 之後把 server 拆開,寫到 `.open-next/split/`(`pnpm worker:split`) |
| `scripts/split-server/transform.mjs` | 拆分的純轉換(`entry.mjs` 改寫 worker.js;`scope.mjs` 範圍分析;`preset.mjs` 讀 wrangler 的 Node 相容設定),測試在同資料夾 |
| `scripts/smoke-worker-boot.mjs` | 開機檢查:`wrangler dev` 跑起建置好的 Worker,打五個網址(`pnpm worker:smoke`) |

## 拆分入口在做什麼

Cloudflare 的 isolate 啟動時,會先編譯所有上傳的模組。wrangler 不做 code splitting,OpenNext 在 `fetch`
裡 `await import` 的 server handler 會被併進主模組,所以預設入口的 Worker 是一個約 24 MB 的模組:任何
請求打到冷的 isolate,都要先等整包編譯完,包括只跑 middleware、根本用不到 Next server 的請求。

拆分入口改成這樣上傳:

| 模組 | 大小(2026-10-29 的建置) |
|---|---|
| 主模組:middleware、圖片、cron、我們的 fetch / scheduled 外層 | 約 1.1 MB |
| `server/handler.js`:Next server,chunk 與路由檔已經搬出去 | 約 4.2 MB |
| `server/chunks/*.cjs`:每個 webpack chunk、每個路由檔各一個(93 + 161 個) | 共約 12.4 MB |
| `server/*.wasm`:og 圖用的 yoga 與 resvg | 約 1.4 MB |

開了 `new_module_registry` 之後,模組第一次被 import / require 才編譯。只跑 middleware 的請求
(`/admin` 未登入的轉址、之後的成品快取)只編譯主模組;需要 Next server 的請求再編譯 server 模組與
這一頁用到的 chunk。cron 的醒來檢查也不碰 server。

做法:`scripts/split-server-chunks.mjs` 用 acorn 解析 OpenNext 的 `handler.mjs`,找出 esbuild 包好的
`var require_X = __commonJS({ ".next/server/chunks/…"(exports, module) { … } })`,本體搬成 CommonJS
模組。搬出去的模組只匯出一個包著本體的函式;原處的本體換成「`__splitRequire("./chunks/….cjs")`
(`createRequire(import.meta.url)`)載入那個模組,呼叫它」。esbuild 的 `__commonJS` 照舊負責快取與
丟錯後重跑。

路由檔會用到 bundle 最上層的名字(`require_webpack_runtime`、async storage、`__toESM`、檔頭 import
的 setTimeout 等),它們必須跟 Next runtime 是同一份實例。server 模組在檔頭建一個 getter 物件
`__splitScope`,每次呼叫時傳給搬出去的函式;本體裡每一處引用 `x` 都改寫成 `__splitScope.x`,每次讀都
拿到當下的值,跟原本的 live binding 一樣。

改過的 server 再交給 wrangler 單獨打包一次,Node 內建模組的別名與 wasm 的處理跟預設入口相同。OpenNext
的 `worker.js` 複製一份到 `.open-next/split/`,載入 server 的那一行改成非字面值的路徑,esbuild 才不會
把 server 併回主模組。OpenNext 自己的輸出一個檔都不改,同一份建置照樣能用預設入口。

workerd 載入 CommonJS 模組的兩個行為(2026-11-12 本機 workerd 1.20261110 實測):

- 模組求值時丟錯,之後每次 require 都丟同一個錯,不再重跑,整個 isolate 存活期間都是壞的。所以搬出去的
  模組載入時只定義函式、不跑本體;本體丟錯時,`__commonJS` 照原本的方式在下一次呼叫重跑。
- 兩個模組互相 require 跟 Node 一樣:後載入的那一個拿到前一個還沒跑完的 exports。

## 必要條件

缺一個就不能用:

1. `compatibility_flags` 有 `"new_module_registry"`。沒有它,舊機制在啟動時照樣編譯所有模組,而且
   server 模組裡的 `import.meta.url` 是 undefined,每個需要 Next server 的請求都會失敗。拆分腳本在
   旗標不在時直接停下。
2. `wrangler.jsonc` 有這三個欄位,讓 wrangler 只掃 `.open-next/split/`、模組名稱是 `server/…`:

   ```jsonc
   "base_dir": ".open-next/split",
   "find_additional_modules": true,
   "rules": [
     { "type": "ESModule", "globs": ["server/*.js"], "fallthrough": false },
     { "type": "CommonJS", "globs": ["server/chunks/*.cjs"], "fallthrough": false }
   ],
   ```

3. 每次 `opennextjs-cloudflare build` 之後跑 `scripts/split-server-chunks.mjs`。`pnpm preview` 與
   `pnpm deploy` 已經接好;沒有選用的站跑到這一步只印一行「不拆分」。

## 哪些站該開

流量不大、訪客常打到冷 isolate 的站,而且有不少請求不需要 Next server(只跑 middleware、或之後由成品
快取回應)。所有請求都需要 Next server 的站,拆分只讓冷請求快約 0.3 秒(見下方實測)。

要開:`main` 改成 `"worker/split-entry.ts"`,加上旗標與上面三個欄位。要退回:`main` 改回
`"custom-worker.ts"`;旗標與三個欄位留著無害(只是多上傳一份用不到的模組),要清乾淨就一起刪掉。

## 失敗時

拆分綁在 OpenNext 與 esbuild 的輸出形狀上,所以三道關卡都在部署之前:

- **拆分腳本嚴格失敗。** 下列任何一種情況都以非零結束,訊息寫明預期什麼、實際看到什麼:
  - 找不到 `__commonJS`、一個 chunk 或路由檔的包裝都沒有,或包裝的形狀不認得、不在最上層的 `var`
  - 搬出去的本體寫入 bundle 最上層的名字(接橋只能讀)、用到包裝函式自己的 `arguments`、在自由範圍
    用到 `module` / `exports`、或已經有拆分要用的名字(`__splitScope` 等)
  - 本體 `require` 或字面值的 `import("…")` 的模組不能直接交給 workerd:這個相容日期下 workerd 不原生
    提供的 Node 模組(原本由 wrangler 換成 unenv 的版本)、相對路徑、套件名稱,或不是字面值的
    `require(…)`。原生與否取自 wrangler 打包時用的 `@cloudflare/unenv-preset`。唯一的例外是會接住錯誤
    的 try 裡的 `require("<套件>")`(選用的相依):那個 try 要有 catch,而且 catch 的最上層沒有 `throw`;
    只有 finally 的 try 不算,`import()` 沒有這個例外
  - 本體用到 `import.meta`(在 .cjs 裡是語法錯誤)
  - 本體用到 wrangler 打包時會注入的全域(舊的相容日期下的 `process`、`console` 等)
  - 兩個路徑寫成同一個檔名(包括只差大小寫)、server 用相對路徑 import、打包後的 server 多了 wasm
    以外的相對 import

  輸出先寫在 `.open-next/` 底下的暫存資料夾,全部成功才改名成 `.open-next/split/`;開始時就刪掉上一次
  的 `.open-next/split/`。失敗或被中斷時 `.open-next/split/` 不存在,拆分入口打包不起來,不會部署到
  拆了一半或上一次 build 的輸出。
- **開機檢查。** 打包得過不等於跑得起來。`scripts/smoke-worker-boot.mjs` 在暫存資料夾的本機 D1 上套
  migrations,用 `wrangler dev --local`(不需要登入)跑起 `main`,檢查 `/` 200、`/admin` 307 到
  `/login`、`/robots.txt` 200、`/api/search` 401、`/__scheduled` 200,有 5xx 或不符就失敗。CI 每個 PR
  跑一次;部署 workflow 在 D1 migrations 與 Deploy 之前跑,失敗時遠端資料庫沒動,線上照舊是舊版本。
  被中斷時照樣停掉 wrangler 與 workerd、刪掉暫存資料夾。
- **指紋。** `.open-next/split/` 只有拆分腳本會刪,所以「重新 build 卻沒有重新拆分」時,磁碟上留著上一次
  的拆分輸出,wrangler 會把舊的 server 配上新的 middleware 與靜態檔一起上傳。拆分時在
  `.open-next/split/fingerprint.json` 記下輸入檔(server handler 與 worker.js)的 sha256;開機檢查與
  `node scripts/split-server-chunks.mjs --check` 比對現在的建置,對不上就失敗。

  有保護的路徑:`pnpm deploy` 與 `pnpm preview`(build 之後一定先拆分)、CI(拆分加開機檢查)、部署
  workflow(拆分、開機檢查,Deploy 之前再跑一次 `--check`)。**沒有保護的是手動跑
  `opennextjs-cloudflare build` 之後直接 `wrangler deploy` 或 `opennextjs-cloudflare deploy`、跳過拆分。**
  手動部署前先跑 `pnpm worker:split`,或至少 `node scripts/split-server-chunks.mjs --check`。

## 升級 OpenNext 或 Next 時

每次升級都要重驗:

1. `opennextjs-cloudflare build`,再 `pnpm worker:split`。看摘要:server 模組與延後模組的數量、大小
   跟上次差太多,先查原因。
2. `pnpm worker:smoke` 全部 ok。
3. `pnpm exec wrangler deploy --dry-run --outdir <暫存資料夾>`:模組清單是一個主模組、`server/handler.js`、
   `server/chunks/*.cjs`、wasm;沒有 repo 裡的其他檔案;主模組只有約 1 MB(變回 20 MB 以上代表 server
   被併回主模組了)。
4. 拆分腳本失敗時,先看訊息指的是哪一種形狀變化。拿不準就先把 `main` 改回 `custom-worker.ts` 部署,
   再回頭改腳本。

wrangler 也有關係:舊的 workerd(wrangler 4.86 附的 1.20260426)開 `new_module_registry` 載入真實的
server 會 SIGBUS 當掉,1.20261023 以後正常。

## 怎麼量

比的是等待時間(新連線,TLS 完成到第一個位元組),不是 CPU。拆分之後,Workers Logs 的 `cpuTimeMs`
在冷請求上會變高:編譯原本在 isolate 啟動時做、不算進任何請求,現在移到請求裡才被計入。

- 部署 5 分鐘以上再量,讓 isolate 都是新版本的。
- 每次新連線,`curl -w '%{time_appconnect} %{time_starttransfer}'` 取兩者的差;每個網址 30 次以上、
  打亂順序。用 `/_next/static/` 下的靜態檔當對照組,未登入的 `/admin` 代表「只跑 middleware」。
- 本機 `wrangler dev` 的數字只看相對變化;Cloudflare 上的結果才算數。

## 經過

- 2026-11-12,Cloudflare 上五種拆法各量兩輪(每格 36 次新連線):只跑 middleware 的路徑,拆分後最差
  0.53 秒、沒有一次超過 0.6 秒,不拆的有 6–11 次;需要 server 的 `/`,冷的等待中位數從 1.31–1.34 秒
  降到 0.96–1.07 秒。整個 server 只拆成一個獨立模組(不逐塊)在 `/` 上沒有比較好。
- 同一次實測裡,原本的「isolate 啟動時建好 Next server」入口(`worker/eager-entry.ts`,2026-10-24
  上線)在兩條路徑上都沒有比預設快,`/admin` 還略慢,所以移除了。不要再加回來。
- 「回應之後用 `ctx.waitUntil` 在背景載入 server」在 sz.ws 試過:背景編譯會卡住同一個 isolate,
  不需要 server 的頁面反而變慢。也不要加。
