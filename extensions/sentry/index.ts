import { defineExtension } from "@/ext/types";
import { SentryAdminPage } from "./admin-page";
import { testEventHandler } from "./test-route";

// 錯誤追蹤 extension —— 自架 GlitchTip(或 Sentry SaaS,同一套協定)的控制面板。
//
// ## 這個 extension 「不做」什麼
//
// 它**不是**回報功能本身。真正的回報層住在 core(`src/lib/observe/`),因為要涵蓋的
// 錯誤發生在 core 裡:src/ext/hooks.ts 的 hook 失敗、Next 的 onRequestError、
// custom-worker.ts 的 cron tick。core 不可能等某個 extension 的程式碼先跑過一次才
// 開始有能力記錄錯誤。
//
// 這個 extension 提供的是**人可以操作的那一半**:一個放 DSN 的地方、一頁看得懂的
// 狀態、一顆按下去就知道到底通不通的按鈕。沒有這三樣,錯誤回報會變成一個「設了但
// 沒人確定有沒有在動」的東西 —— 而那比沒裝更糟,因為它會讓人以為自己有在看。
//
// ## 為什麼 DSN 是 secret:true
//
// DSN 嚴格說起來不是機密:瀏覽器那半邊一定要拿得到才能回報,所以它本來就會被編進
// 前端 bundle,而且它能做的事只有「往這個專案送事件」。
//
// 標成 secret 的理由是另一件事:這個 CMS 是拿來 fork 的公開範本,而站台設定會被匯出、
// 會被貼進工單、會被複製到另一個站當範本。secret 管線讓這顆值加密落地、API 只寫不讀、
// 後台只顯示遮罩 —— 代價是零,而它擋掉的是「B 站的錯誤全部灌進 A 站的 GlitchTip 配額」
// 這種沒人會馬上發現的事。
//
// ⚠️ 這裡的 default 是空字串,而且**永遠**是空字串。硬編一顆 DSN 進來會讓每一個
// fork 出去的站把它的錯誤(連同堆疊裡的資料)送到原作者的收集端。
//
// coreApi "^1.26.0":依賴 core 的 `@/lib/observe/report`(1.26.0 新增)。

export const sentry = defineExtension({
  id: "sentry",
  name: { en: "Error tracking", "zh-Hant": "錯誤追蹤" },
  version: "1.0.0",
  coreApi: "^1.26.0",
  description: {
    en: "Sends unhandled errors, failed extension hooks and failed cron ticks to a self-hosted GlitchTip (or Sentry) project.",
    "zh-Hant":
      "把沒接住的例外、失敗的 extension hook 與失敗的 cron tick 送到自架的 GlitchTip(或 Sentry)專案。",
  },
  icon: "bug",
  settings: [
    {
      key: "dsn",
      label: { en: "Error tracking DSN", "zh-Hant": "錯誤追蹤 DSN" },
      description: {
        en: "From your GlitchTip project settings. Empty turns error reporting off entirely. Applies to the server side immediately; the browser half needs NEXT_PUBLIC_CMS_ERROR_DSN at build time.",
        "zh-Hant":
          "從 GlitchTip 專案設定複製。留空 = 整套關閉。伺服器端存檔即生效;瀏覽器那半邊要在建置時設 NEXT_PUBLIC_CMS_ERROR_DSN。",
      },
      type: "text",
      secret: true, // → ext.sentry.dsn,自動走 AES-GCM 加密管線(理由見檔頭)。
      default: "",
    },
  ],
  adminPages: [
    {
      slug: "",
      title: { en: "Error tracking", "zh-Hant": "錯誤追蹤" },
      component: SentryAdminPage,
    },
  ],
  apiRoutes: [
    {
      method: "POST",
      path: "test-event",
      handler: testEventHandler,
    },
  ],
});
