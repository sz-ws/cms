import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/observe/sentry-options";

// [core] 不要在客戶站改這個檔。
//
// 瀏覽器這一側的錯誤回報初始化。Next.js 會自動把這個檔案排進前端 bundle,不需要在
// 任何地方 import 它 —— 檔名就是約定。
//
// 這半邊的價值比 server 端低:使用者自己看得到壞掉的畫面。但它會抓到一種伺服器端
// 完全看不到的東西 —— 只在某個瀏覽器、某支手機上炸開的錯誤。這個後台有 richtext
// 編輯器、媒體上傳、WebAuthn passkey 註冊,那幾樣的瀏覽器實作差異都很大。
//
// ⚠️ **前端這顆 DSN 只能來自環境變數,而且是建置期決定的。** 後台設定頁那顆存在 D1
// 裡,瀏覽器讀不到,也不該讀得到。所以換前端 DSN 一定要重新 build —— 這和 server 端
// 不一樣(那邊填完存檔就生效)。後台狀態頁會把這件事講清楚,免得有人填完設定卻發現
// 前端事件一筆都沒有。

Sentry.init({
  ...sentryOptions({
    // ⚠️ 這一行不能「整理得更漂亮」。Next 是在**建置期**用字串取代的方式把
    // `process.env.NEXT_PUBLIC_CMS_ERROR_DSN` 這個完整字面形式換掉的;拆成變數、用
    // 計算的方式組出 key、或改成解構寫法,拿到的都會是 undefined。
    dsn: process.env.NEXT_PUBLIC_CMS_ERROR_DSN,
    /*
     * 前端要用 window 判斷所在環境,**不能**用 process.env.CMS_ERROR_ORIGIN ——
     * 那個變數沒有 NEXT_PUBLIC_ 前綴,在瀏覽器 bundle 裡是 undefined,結果會是整批
     * 前端事件都被標成本機(或反過來,本機的錯誤被當成正式站送出去)。
     *
     * 拿不到 window 就留 undefined,那會被判成 local 也就是靜音 —— 判斷不出來的時候
     * 寧可不送,不要亂送。
     */
    origin: typeof window === "undefined" ? undefined : window.location.origin,
  }),

  /**
   * 明確不要 Session Replay。
   *
   * GlitchTip 根本不支援,而就算之後換回 Sentry SaaS —— 錄下這個後台的畫面等於把
   * 使用者的每一次登入輸入、每一筆還沒發佈的內容錄起來。遮罩設定再周全,這都不是
   * 一個值得為了「比較好重現問題」而冒的險。
   */
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
});

/**
 * 路由切換的 instrumentation 掛鉤。
 *
 * 我們的 tracesSampleRate 是 0,所以它實際上什麼都不做 —— 留著純粹是因為少了它,
 * SDK 會在**每一次** `next build` 印一行 `ACTION REQUIRED:` 的警告。而一行寫著
 * 「需要採取行動」的建置訊息,遲早會讓某個人以為有東西壞了,然後花半小時去查一件
 * 我們早就決定不做的事。用一行程式碼換掉那半小時是划算的。
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
