import { decryptSecretWithKey } from "../../src/lib/secret-envelope";
import { resolveDsn, sentryOptions } from "../../src/lib/observe/sentry-options";

// cron 那條路的錯誤回報。由 custom-worker.ts 的 `scheduled` handler 呼叫。
//
// ## 為什麼這裡要自己 init 一次
//
// `scheduled` 完全不經過 Next.js —— 它是 wrangler 的 `main`(custom-worker.ts)直接
// 掛的 handler。所以 Next 那一側的回報(src/instrumentation.ts、report.ts)對這條路**一次都不會經過**,
// Next 版 SDK 在這裡是完全沒有初始化的。不自己 init,cron 就是整條線上唯一一段
// 收不到任何錯誤的路徑 —— 而它偏偏又是最需要被監看的那一段:沒有人在瀏覽,壞了
// 也沒有畫面會變醜,runCronTick 的合約還是「絕不 throw」。
//
// 用的是同一個 `@sentry/nextjs`,不是第二個 SDK 套件。它的 package exports 有
// `workerd` 條件,在 Worker 入口這條路會解析到 edge build(fetch 傳輸、無 Node API),
// 正好是這裡需要的形狀。
//
// ## SDK 為什麼是動態載入
//
// custom-worker.ts 是整支 Worker 的入口,這裡的靜態 import 會在**每一個** isolate 啟動
// 時執行 —— 包括只服務一般網頁請求、從來不跑 cron 的那些。所以 SDK 只在確定有 DSN
// 要綁的時候才載入(bindScheduledReporting 內);沒設 DSN 的站從頭到尾不碰它。
// 載入的是 ./scheduled-sdk(只轉出用得到的三個函式),理由見該檔。
//
// ## import 硬規則(和 extensions/cron/scheduled.ts 同一條)
//
// 本檔只能 import:./scheduled-sdk(動態,裡面只有 @sentry/nextjs)、../../src/lib/secret-envelope(純 Web Crypto)、
// ../../src/lib/observe/sentry-options(型別 + 純函式,沒有 runtime 相依)。
// 任何 `@/` 別名 / next/* / drizzle / lib/db 都會把整個 Next module graph 拖進 worker
// 入口的 bundle —— 那是這條路線唯一會致命的失誤。D1 一律用原生 prepare/bind。

const DSN_SETTING_KEY = "ext.sentry.dsn";
const SITE_URL_KEY = "core.siteUrl";
const EXT_ID = "sentry";

/** `scheduled(event, env, ctx)` 拿得到的東西(全部 optional:缺就安靜降級)。 */
export interface ScheduledObserveEnv {
  DB?: D1Database;
  SECRETS_KEY?: string;
  /** 環境變數那條路。⚠️ 絕不能叫 SENTRY_DSN,理由見 sentry-options.ts。 */
  CMS_ERROR_DSN?: string;
  CMS_ERROR_ORIGIN?: string;
  CMS_ERROR_ALLOW_LOCAL?: string;
  CMS_ERROR_DEBUG?: string;
  CMS_ERROR_RELEASE?: string;
}

interface ObserveRow {
  dsn: string | null;
  site_url: string | null;
  enabled: number | null;
}

// 一次 round-trip 取齊三件事:extension 是否啟用、加密後的 DSN、站台 origin。
// (settings.value 一律是 JSON.stringify 後的字串,讀出來要先 JSON.parse。)
const OBSERVE_QUERY = `SELECT
  (SELECT value FROM settings WHERE key = ?1) AS dsn,
  (SELECT value FROM settings WHERE key = ?2) AS site_url,
  (SELECT enabled FROM extensions WHERE id = ?3) AS enabled`;

/** JSON.parse 出非空字串才回傳;其餘(非字串 / 壞 JSON / null)一律 null。 */
function parseJsonString(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

type SentrySdk = typeof import("./scheduled-sdk");

/**
 * isolate 級的「已經綁過了」旗標。
 *
 * cron 每分鐘醒一次,而同一個 isolate 可能被重複用很多次。每次都重跑一遍 D1 查詢
 * 加解密只是白花錢;而且 init 兩次以上在 SDK 這邊也不是免費的。
 *
 * `false` 同時涵蓋「沒設定」與「設定過但判定不送」——兩者對呼叫端來說行為一樣,
 * 差別只在後台狀態頁怎麼解釋,而那是另一條路(有 request context)的事。
 *
 * 綁成功時一併留住載入的 SDK,之後的 capture / flush 都用這一份。
 */
let bound: SentrySdk | false | null = null;

async function bindScheduledReporting(
  env: ScheduledObserveEnv,
): Promise<SentrySdk | false> {
  if (bound !== null) return bound;
  bound = false; // 先寫死 false:下面任何一步炸掉都不該讓每分鐘的 tick 一直重試。

  let dsn = env.CMS_ERROR_DSN?.trim() ?? "";
  let origin = env.CMS_ERROR_ORIGIN?.trim() || undefined;

  // 後台設定那顆優先 —— 那是站台管理者剛按下去的,環境變數是上次部署留下的。
  // 這一段整個是「有更好就用,沒有就算了」,所以任何失敗都只 log 不中斷。
  if (env.DB && env.SECRETS_KEY) {
    try {
      const row = await env.DB.prepare(OBSERVE_QUERY)
        .bind(DSN_SETTING_KEY, SITE_URL_KEY, EXT_ID)
        .first<ObserveRow>();
      const siteUrl = parseJsonString(row?.site_url ?? null);
      if (siteUrl) origin = siteUrl;
      // extension 沒裝 / 停用時**不碰**那個 key:secret 設定的解密判定是依「已啟用
      // extension 宣告的 secret 欄位」做的,停用狀態下那顆值就只是一段密文。
      const stored = row?.enabled === 1 ? parseJsonString(row.dsn) : null;
      if (stored) dsn = await decryptSecretWithKey(env.SECRETS_KEY, stored);
    } catch (e) {
      console.error("[observe] scheduled: failed to read reporting settings", e);
    }
  }

  const ctx = {
    dsn: dsn || undefined,
    origin,
    allowLocal: env.CMS_ERROR_ALLOW_LOCAL === "1",
    debug: env.CMS_ERROR_DEBUG === "1",
    release: env.CMS_ERROR_RELEASE || undefined,
  };
  // 沒 DSN 或判定成本機 → 安靜關閉,SDK 連載入都不發生。
  if (!resolveDsn(ctx)) return bound;

  try {
    const Sentry = await import("./scheduled-sdk");
    Sentry.init(sentryOptions(ctx));
    bound = Sentry;
  } catch (e) {
    console.error("[observe] scheduled: Sentry.init failed", e);
  }
  return bound;
}

/** 失敗的收集口。stage 只是分類標籤,不放任何資料。 */
export type ScheduledErrorSink = (error: unknown, stage: string) => void;

/**
 * 把一段 `scheduled` 的工作包在錯誤回報裡。
 *
 * 三件事一起做,因為漏掉任何一件這條路就又回到全靜音:
 *   1. 綁 client(這條路沒有人替我們做)。
 *   2. 接住 run() 自己丟出來的東西 —— `scheduled` 沒有人接得住例外,漏出去只會變成
 *      Cloudflare 儀表板上一個沒有上下文的計數。
 *   3. **flush**。這是最容易漏的一步:Worker 的 isolate 在 handler 的 promise 解決後
 *      隨時可能被回收,而 SDK 的送出是非同步的 —— 不等它,事件會在還沒離開機器前
 *      就跟著 isolate 一起消失,而且不會有任何跡象。
 *
 * 整支函式絕不 throw:監控壞掉不該讓 cron 跟著壞掉。
 */
export async function withScheduledReporting(
  env: ScheduledObserveEnv,
  run: (report: ScheduledErrorSink) => Promise<void>,
): Promise<void> {
  let sdk: SentrySdk | false = false;
  try {
    sdk = await bindScheduledReporting(env);
  } catch (e) {
    console.error("[observe] scheduled: bootstrap failed", e);
  }

  const report: ScheduledErrorSink = (error, stage) => {
    if (!sdk) return;
    try {
      sdk.captureException(error, { tags: { path: "scheduled", stage } });
    } catch (e) {
      console.error("[observe] scheduled: capture failed", e);
    }
  };

  try {
    await run(report);
  } catch (e) {
    console.error("[observe] scheduled: unhandled error", e);
    report(e, "unhandled");
  }

  if (!sdk) return;
  try {
    // 2 秒:比一次 GlitchTip 往返寬裕,又遠低於 scheduled 的時間預算。等不到就放棄,
    // 不要為了一筆錯誤報告把 tick 卡住。
    await sdk.flush(2000);
  } catch (e) {
    console.error("[observe] scheduled: flush failed", e);
  }
}
