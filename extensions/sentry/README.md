# 錯誤追蹤(GlitchTip / Sentry 協定)

把沒接住的例外、失敗的 extension hook 與失敗的 cron tick 送到自架的
**GlitchTip**(或任何說 Sentry envelope 協定的收集端,包含 Sentry SaaS)。

DSN 留空 = 整套安靜關閉:沒有網路流量、沒有 SDK 初始化、沒有警告。這是新站的
預設狀態,也是 fork 這個 repo 之後應該維持的狀態,直到有人真的架好收集端。

## 分工:core 做事,這個 extension 是控制面板

回報層本體住在 **core**(`src/lib/observe/`),因為要涵蓋的錯誤發生在 core 裡:
`src/ext/hooks.ts` 的 hook 失敗、Next 的 `onRequestError`、`custom-worker.ts` 的
cron tick。core 不可能等某個 extension 的程式碼先跑過一次才開始有能力記錄錯誤。

這個 extension 提供的是**人可以操作的那一半**:一個放 DSN 的地方、一頁看得懂的
狀態、一顆按下去就知道到底通不通的按鈕。

| 檔案 | 職責 |
| --- | --- |
| `index.ts` | manifest(dsn setting、adminPage、test-event route) |
| `admin-page.tsx` | 狀態頁:DSN 來源、環境層級、有沒有在送、涵蓋範圍 |
| `TestEventButton.tsx` | 送一筆測試事件,回傳 event id |
| `test-route.ts` | `POST /api/ext/sentry/test-event`(走完整真實路徑) |
| `scheduled.ts` | cron 那條路自己的 init + flush(由 `custom-worker.ts` 呼叫) |

## 啟用

1. `extensions/registry.ts` 已掛載(預設 bundle 的一員)。
2. Admin → Extensions → 錯誤追蹤 → 啟用。沒有 migration,沒有建表。
3. 設定頁 Extensions 區填 **錯誤追蹤 DSN**(GlitchTip 專案設定裡的那一串)。
   加密儲存(`secret: true`),存檔即生效,不用重新部署。
4. 設定頁 General 區的 **Site URL** 必填 —— 它決定事件被標成哪一層
   (production / staging / local)。沒填 = 判定成本機 = 不送。
5. 回到這一頁按「送出測試事件」。拿到 event id 就代表整條線通了。

## DSN 的兩個來源

| 來源 | 何時生效 | 涵蓋範圍 |
| --- | --- | --- |
| 設定 `ext.sentry.dsn`(這個 extension) | 存檔即生效 | 伺服器端 + cron。優先於環境變數 |
| 環境變數 `CMS_ERROR_DSN`(wrangler var) | 重新部署後 | 同上,而且在 module load 就綁好,連「還沒進到我們任何一行程式碼」的請求都收得到 |
| 環境變數 `NEXT_PUBLIC_CMS_ERROR_DSN` | 重新 **build** 後 | **只有**瀏覽器端。設定頁那顆對它無效 —— 瀏覽器讀不到 D1 |

正式站建議兩邊都設(同一顆 DSN):設定那條讓人隨時改得動,環境變數那條讓最早期
的錯誤也收得到。

## 環境變數一覽

| 變數 | 用途 |
| --- | --- |
| `CMS_ERROR_DSN` | 伺服器端 / cron 的 DSN |
| `NEXT_PUBLIC_CMS_ERROR_DSN` | 瀏覽器端的 DSN(建置期決定) |
| `CMS_ERROR_ORIGIN` | module load 那一刻的站台 origin 替身(讀不到 D1 時用)。可不設 |
| `CMS_ERROR_ALLOW_LOCAL=1` | 本機也送。預設本機不送,理由見下 |
| `CMS_ERROR_DEBUG=1` | 印出 SDK 每一次傳輸的結果 |
| `CMS_ERROR_RELEASE` | 覆寫事件上的版本標記 |

> ⚠️ **絕對不要把 DSN 放進名為 `SENTRY_DSN` 的環境變數。** SDK 內部是
> `dsn: options.dsn ?? process.env.SENTRY_DSN` —— 傳 `undefined` 想關掉它時,它會
> 自己回頭去環境變數把 DSN 撿回來,把整段本機靜音判斷繞過去。所有變數名都刻意
> 避開那個字樣,不要「順手改回標準名稱」。

## 為什麼本機預設不送

本機的錯誤會和正式站的**混進同一組 issue**。之後看到一筆,你分不出那是使用者真的
遇到了,還是某個人 `next dev` 時自己弄出來的 —— 而錯誤清單一旦開始說謊,它就不再
是可以依賴的東西。而且本機的例外裡什麼都可能有:測試資料、隨手打的假 email、
堆疊裡開發機的絕對路徑。

做法是**直接不給 DSN**,不是 `beforeSend` 回 null:後者事件已經組好了只是最後一刻
丟掉,前者連傳輸層都不會建立。

要在本機實測整條線:

```bash
pnpm exec wrangler dev --var CMS_ERROR_ALLOW_LOCAL:1
```

前端沒有對應的開關 —— 要驗前端就另開一個 GlitchTip 專案,別讓它有機會汙染正式站
那一組。

## 送出去的東西有做刪去法清理

`src/lib/observe/sentry-options.ts` 的 `scrubEvent`:cookie / authorization /
`x-api-token` / `x-signature` header、`request.data`(請求內文)、cookies、
query string(含網址上的參數)、`event.user` 一律刪掉。

理由是這個 CMS 什麼資料都碰得到:使用者 email、未發佈的內容、表單提交、剛填進去
還沒加密的 secret 設定值。一份夠詳細的錯誤報告本身就是一次外洩,而錯誤追蹤系統的
存取控制永遠比正式資料庫鬆。所以是刪去法,不是列舉法。

tracing(`tracesSampleRate: 0`)與 session replay(兩個 sample rate 都 0)全關:
GlitchTip 不吃這些,而錄下後台畫面等於錄下每一次登入輸入。

## 測試

- `test/observe-sentry-options.test.ts` —— 環境層級判定、刪去法清理、本機抑制。
- `test/cron-scheduled.test.ts` —— cron tick 的失敗回報(`onError` sink):該回報
  時回報、「未安裝 / 未啟用 / 未設密鑰」這些正常狀態安靜跳過。
