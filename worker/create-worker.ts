import { runCronTick } from "../extensions/cron/scheduled";
import { withScheduledReporting } from "../extensions/sentry/scheduled";
import { runInRequestScope } from "../src/lib/request-scope";
import { runTimed, startTiming, timedEnv, withServerTiming } from "../src/lib/server-timing";

/** OpenNext 產出的 handler(`.open-next/worker.js` 或拆分後的 `.open-next/split/worker.js`)的 default export。 */
export interface OpenNextHandler {
  fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Response | Promise<Response>;
}

// 兩個 Worker 入口(custom-worker.ts、worker/split-entry.ts)共用的 fetch 與 scheduled。入口只決定
// 從哪裡拿 OpenNext 的 handler;包在外面的這一層只寫在這裡一次。
//
// 這個檔不 import 任何 .open-next/ 的東西:handler 由入口傳進來。拆分入口的主模組因此不會被打包
// 進未拆分的 server。
export function createWorker(openNextHandler: OpenNextHandler) {
  return {
    // Worker 變數 CMS_SERVER_TIMING = "1" 時量每個請求等 D1、R2、對外 fetch 各多久(src/lib/server-timing.ts),
    // 寫進 Server-Timing 標頭與 log;沒設就直接交給 OpenNext,不多包任何東西。
    async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
      // 每個請求一個請求範圍(src/lib/request-scope.ts):Route Handler 沒有 React cache() 的
      // 「同一個請求」,靠它讓同一個請求裡算過的東西(版本戳)不必每次重問 D1。
      return runInRequestScope(async () => {
        if ((env as unknown as { CMS_SERVER_TIMING?: string }).CMS_SERVER_TIMING !== "1") {
          return openNextHandler.fetch(request, env, ctx);
        }
        const timing = startTiming();
        const response = await runTimed(timing, () => openNextHandler.fetch(request, timedEnv(env, timing), ctx));
        return withServerTiming(request, response, timing, ctx);
      });
    },

    // 分鐘級準時排程的「錶」。實作在 extensions/cron/scheduled.ts —— core 本身
    // 永遠只有 lazy sweep,secret 與 tick 入口都屬於 cron extension(見該檔註解)。
    // scheduled 沒有 request context,不能碰 getCloudflareContext();env 由此處直接傳入。
    // runCronTick 絕不 throw:cron 沒裝/沒啟用/沒設密鑰都是安靜 no-op。
    //
    // 但「不 throw」在這裡等於「沒有人知道」——這條路不經過 Next.js,所以
    // Next 的 instrumentation 與 report.ts 一次都不會經過,SDK 在這裡是完全沒初始化的。
    // withScheduledReporting 補上那一次 init,並把 runCronTick 的失敗(它照樣不 throw,
    // 只是多接一個 sink)送出去,最後等 flush —— isolate 一被回收,沒送完的事件就沒了。
    // 它自己也絕不 throw:監控壞掉不該讓 cron 跟著壞掉。
    async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(withScheduledReporting(env, (report) => runCronTick(env, report)));
    },
  };
}
