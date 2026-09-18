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
//
// ## 為什麼 SDK 是在 if 裡動態載入
//
// 這個檔案排在**每一個**前端頁面的進入點裡,比 hydration 還早執行。檔頭靜態 import
// @sentry/nextjs 的話,沒設 DSN 的站也要讓每個訪客先下載、執行整包 SDK。現在:
//   - 建置時沒設 NEXT_PUBLIC_CMS_ERROR_DSN → 條件恆假,SDK 的 chunk 從不被請求;
//   - 有設 → SDK 另成一個 chunk 非同步載入,不擋 hydration。
// 代價是 SDK 載入完成之前(頁面最早的那一小段)發生的錯誤收不到。這一半本來就是
// 補充,拿每一頁的首屏去換那一小段不划算。
//
// 路由切換的 onRouterTransitionStart 掛鉤刻意不匯出:tracesSampleRate 是 0,它什麼都
// 不做;建置期那行「ACTION REQUIRED」警告由 next.config.ts 的
// suppressOnRouterTransitionStartWarning 關掉。

// ⚠️ 條件與下面 dsn 那兩處的寫法不能「整理得更漂亮」。Next 是在**建置期**用字串取代的
// 方式把 `process.env.NEXT_PUBLIC_CMS_ERROR_DSN` 這個完整字面形式換掉的;用計算的方式
// 組出 key、或改成解構寫法,拿到的都會是 undefined。
if (process.env.NEXT_PUBLIC_CMS_ERROR_DSN) {
  void Promise.all([
    // webpackExports:只收 init,SDK 其餘匯出讓打包剪掉(動態 import 預設全部留下)。
    import(/* webpackExports: ["init"] */ "@sentry/nextjs"),
    import("@/lib/observe/sentry-options"),
  ])
    .then(([Sentry, { sentryOptions }]) => {
      Sentry.init({
        ...sentryOptions({
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
    })
    .catch((e: unknown) => {
      // 載不到 SDK(斷網、chunk 被擋)不該變成頁面上的錯誤。
      console.error("[observe] browser error reporting failed to start", e);
    });
}
