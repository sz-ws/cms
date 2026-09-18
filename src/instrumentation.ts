import type { Instrumentation } from "next";

import { getRequestErrorForwarder } from "@/lib/observe/bridge";

// [core] 不要在客戶站改這個檔。
//
// Next.js 的 instrumentation 進入點。onRequestError 是 Next 15+ 的鉤子,server
// component、route handler 與 middleware 裡沒被接住的例外都會經過它。
//
// ⚠️ 位置必須是 src/instrumentation.ts,不是 repo 根目錄。app 在 src/app 時,Next 只在
// src/ 底下找這個檔(build 的 rootDir = appDir 的上一層);放在根目錄會被**靜默忽略**
// —— 不報錯,只是這裡的鉤子從來不會被呼叫。這個檔之前就在根目錄,那段期間框架邊界的
// 例外只靠 Sentry 的自動包裝在接(見 next.config.ts 為什麼把包裝關掉)。
//
// ## 為什麼這個檔幾乎什麼都不 import
//
// 這是每個 isolate 都會載入的模組,而 Next 把它編進自己的一層:在這裡 import 的東西
// 會在 server bundle 裡另外長出一份。SDK 與 report.ts 背後的整條相依鏈在這裡 import
// 一次,bundle 就多 2MB,每次冷啟動都要多解析一遍。所以真正的回報邏輯住在
// report.ts(頁面那幾層載入的那一份),這裡經 ../lib/observe/bridge 轉過去。
//
// ## 沒有 register()
//
// 以前這裡有一個在啟動時依環境變數 DSN 先 Sentry.init 的 register()。拿掉的理由同上:
// 它會把 SDK 拉進這一層。環境變數那顆 DSN 仍然有效 —— 第一個要回報東西的地方
// (reportError / 這裡的 onRequestError / cron)會經 ensureReporting 把它綁上。
// (那個 register() 其實從沒跑過:檔案在根目錄,見上。)
//
// ⚠️ 這個檔案**碰不到 cron**。custom-worker.ts 的 `scheduled` handler 完全不經過
// Next.js —— 那邊自己 init 一次,見 extensions/sentry/scheduled.ts。

/**
 * 沒被接住的 server 端錯誤 → report.ts 的 captureRequestError(先 ensureReporting,
 * 確定會送才載入 SDK;沒設 DSN 的站連錯誤發生時都不載入)。
 *
 * 整支絕不 throw:回報失敗不該把「一個錯誤」變成「兩個錯誤」。
 *
 * 注意這個鉤子的守備範圍:它只看得到**丟到框架邊界**的例外。任何被 try/catch 接住
 * 然後只 console.error 的東西,它一個都收不到 —— 這個 repo 裡最貴的幾個故障正好就是
 * 那種形狀,所以那些地方必須自己呼叫 reportError(見 src/ext/hooks.ts)。
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const forward = getRequestErrorForwarder();
  if (!forward) return; // 這個 isolate 還沒載入過 report.ts:見 bridge.ts 的缺口說明。
  try {
    await forward(error, request, context);
  } catch (e) {
    console.error("[observe] onRequestError failed to report", e);
  }
};
