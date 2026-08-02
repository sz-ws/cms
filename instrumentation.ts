import * as Sentry from "@sentry/nextjs";

// [core] 不要在客戶站改這個檔。
//
// Next.js 的 instrumentation 進入點。register() 由框架在 runtime 起來時呼叫一次;
// onRequestError 是 Next 15+ 的鉤子,server component 與 route handler 裡沒被接住的
// 例外都會經過它。
//
// ⚠️ 這個檔案**碰不到 cron**。custom-worker.ts 的 `scheduled` handler 完全不經過
// Next.js,所以 register() 對那條路一次都不會觸發 —— 那邊自己 init 一次,見
// extensions/sentry/scheduled.ts。

export async function register(): Promise<void> {
  // 兩個 config 用動態 import 而不是靜態 import:server 與 edge 是兩份不同的 bundle,
  // 靜態寫法會把兩邊的 SDK 都拉進同一包。
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * 沒被接住的 server 端錯誤。
 *
 * 這裡刻意包一層而不是直接 `export const onRequestError = Sentry.captureRequestError`:
 * 站台如果是在後台填 DSN(而不是設環境變數),module load 時 SDK 手上是沒有 DSN 的 ——
 * 直接轉發等於這條路永遠靜音。先 ensureReporting 一次,設定裡那顆 DSN 才會在這個
 * isolate 綁上去。它自己有 isolate 級的去重,不是每個錯誤都重綁一次。
 *
 * ensureReporting 絕不 throw,所以這層包裝不會把「回報失敗」變成「請求失敗」。
 *
 * 動態 import 是必要的:report.ts 會走到 settings / ext loader(drizzle、D1),那整條
 * 相依鏈不該在 instrumentation 這個最早載入的模組上變成靜態依賴。
 *
 * 注意這個鉤子的守備範圍:它只看得到**丟到框架邊界**的例外。任何被 try/catch 接住
 * 然後只 console.error 的東西,它一個都收不到 —— 這個 repo 裡最貴的幾個故障正好就是
 * 那種形狀,所以那些地方必須自己呼叫 reportError(見 src/ext/hooks.ts)。
 */
export const onRequestError: typeof Sentry.captureRequestError = async (
  error,
  request,
  context,
) => {
  try {
    const { ensureReporting } = await import("@/lib/observe/report");
    await ensureReporting();
  } catch (e) {
    console.error("[observe] onRequestError bootstrap failed", e);
  }
  return Sentry.captureRequestError(error, request, context);
};
