import type { ErrorEvent, init } from "@sentry/nextjs";

// [core] 不要在客戶站改這個檔 —— 錯誤回報的共用設定。
//
// 有四個地方會初始化 SDK(server / edge / browser / cron 的 scheduled),但真正的
// 決定全部集中在這裡,那四個檔案只負責「把 DSN 與 origin 交進來」。分散的話,遲早
// 會出現「前端有清理、後端沒有」這種只在事後才發現的不一致。
//
// ## 為什麼設定得這麼保守
//
// 這條線的終點預設是**自架的 GlitchTip**,不是 Sentry SaaS。GlitchTip 說的是同一種
// envelope 協定,所以 SDK 完全通用,但它只認真處理「錯誤」這一半:
//
//   - tracing / transactions —— 支援很薄,而且每一筆 span 都要自己付儲存
//   - session replay —— 完全不支援,送過去只是白白吃頻寬
//   - profiling —— 同上
//
// 所以 tracesSampleRate 是 0,而不是「先開個 0.1 看看」。在 Workers 上這不只是省錢:
// 每個 integration 都會進 bundle,而 Worker 有硬性大小上限。
//
// 要換成 Sentry SaaS 只要換 DSN —— 這個檔案一行都不用動,只有想開 tracing 時才需要
// 回來調 tracesSampleRate。
//
// ## 這個檔案的 import 紀律
//
// 只 import `type`。理由不是潔癖:`extensions/sentry/scheduled.ts` 會從 Worker 入口
// (custom-worker.ts)引用本檔,而那條路徑一旦拖進任何 runtime 相依(next/*、drizzle、
// @/lib/db)就會把整個 Next module graph 塞進 worker 入口的 bundle。型別在編譯後
// 完全消失,所以這裡是安全的;加一行 runtime import 就不是了。

type SentryOptions = NonNullable<Parameters<typeof init>[0]>;

/**
 * 這份程式碼正跑在哪一層。
 *
 * 三層而不是兩層:staging 是**已經部署出去的**環境,那裡的錯誤和正式站一樣值得看,
 * 只是要能分開篩。真正需要靜音的只有本機。
 */
export type ObserveLayer = "production" | "staging" | "local";

/**
 * 本機主機名。`.local` / `.localhost` 一併算進來 —— 很多人本機開發是走
 * `cms.local` 這種自訂 hosts,不是 localhost。
 */
function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
}

/**
 * 由 origin 判斷所在層級。
 *
 * 刻意**不用 NODE_ENV**:OpenNext 產出的 Worker 一律是 production build,NODE_ENV
 * 分不出正式站和本機 `wrangler dev`。origin 是唯一在四個 runtime 都拿得到、而且真的
 * 反映「這是不是使用者看得到的那個站」的東西。
 *
 * `*.workers.dev` / `*.pages.dev` 判成 staging:那是 Cloudflare 給的預設網域,幾乎
 * 都是還沒接自訂網域的預覽站。判錯的代價很低(事件照送,只是標籤不同),而把預覽站
 * 的錯誤混進正式站的清單代價很高。
 *
 * 這個 CMS 是給人 fork 的範本,所以**不能**像單一站台那樣把正式站 origin 寫死。
 */
export function layerOf(origin: string | undefined | null): ObserveLayer {
  if (!origin) return "local";
  let host: string;
  let protocol: string;
  try {
    const url = new URL(origin);
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    // 解不出來的東西不要猜。判不出來 = local = 不送(見下方 silenced)。
    return "local";
  }
  if (isLocalHost(host)) return "local";
  if (protocol !== "https:") return "local";
  if (host.endsWith(".workers.dev") || host.endsWith(".pages.dev")) {
    return "staging";
  }
  return "production";
}

/**
 * 會被整包丟掉的請求標頭。
 *
 * cookie 是第一名 —— 裡面有 session,那是一把可以直接變成該使用者的鑰匙。SDK 在
 * sendDefaultPii 關閉時本來就不會帶,但「預設不帶」和「明確刪掉」是兩件事:前者是
 * 某個版本的預設值,後者是我們的決定。
 *
 * x-signature 是 cron / 金流回呼的 HMAC 簽章;x-api-token / authorization 是內容 API
 * 的 bearer token。這些都足以讓拿到錯誤報告的人重放一次請求。
 */
const STRIPPED_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "x-api-key",
  "x-api-token",
  "x-signature",
];

/**
 * 把事件裡不該離開這台機器的東西拿掉。
 *
 * 這是**刪去法,不是列舉法** —— 理由是這個 CMS 什麼資料都碰得到:使用者 email、
 * 未發佈的內容、表單提交、加密設定的明文。一份夠詳細的錯誤報告本身就是一次外洩,
 * 而錯誤追蹤系統的存取控制永遠比正式資料庫鬆。所以預設是「全部丟掉」,想留什麼
 * 再一項一項加回來,不是反過來。
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // 就算 sendDefaultPii 是 false,scope 上仍可能被某個呼叫端 setUser 過。這裡是
  // 最後一道,不假設上游有沒有守規矩。
  delete event.user;

  const request = event.request;
  if (!request) return event;

  if (request.headers) {
    const headers = { ...request.headers };
    for (const key of Object.keys(headers)) {
      if (STRIPPED_HEADERS.includes(key.toLowerCase())) delete headers[key];
    }
    request.headers = headers;
  }

  // 請求內文。後台的每一次存檔、每一次登入、每一次設定寫入都在 body 裡 ——
  // 包含密碼與剛填進去、還沒加密的 secret 設定值。
  delete request.data;
  delete request.cookies;
  // query string 一併清掉:目前的登入流程不走驗證連結,但「目前不走」不是一個
  // 可以長期依賴的前提;而搜尋參數(?q=)本身就是使用者輸入。
  delete request.query_string;

  if (typeof request.url === "string") {
    request.url = request.url.split("?")[0];
  }

  return event;
}

export interface ObserveContext {
  /**
   * ⚠️ 這個值**絕對不能**放在名為 `SENTRY_DSN` 的環境變數裡。
   *
   * SDK 內部是 `dsn: options.dsn ?? process.env.SENTRY_DSN` —— 也就是說我們傳
   * undefined 想關掉它的時候,它會自己回頭去環境變數把 DSN 撿回來,把下面整段
   * 「本機靜音」的判斷完全繞過去。實測過:本機的錯誤照樣飛到正式站的 GlitchTip。
   *
   * 所以這個專案的變數叫 `CMS_ERROR_DSN`(瀏覽器那顆是 `NEXT_PUBLIC_CMS_ERROR_DSN`)。
   * 名字避開之後,DSN 只有一條路進得了 SDK:我們手上這個參數。
   *
   * **不要「順手改回標準名稱」。** 那個改動不會有任何錯誤訊息,只會讓本機的例外
   * 開始悄悄混進正式站的 issue 清單。
   */
  dsn: string | undefined;
  /**
   * 這個 runtime 看到的自身 origin。四邊拿法不同,所以由呼叫端給:
   * Worker 用 `core.siteUrl` 設定(拿不到才退回 CMS_ERROR_ORIGIN),瀏覽器用
   * `window.location.origin`。後者**不能**用 process.env —— 沒有 NEXT_PUBLIC_ 前綴
   * 的變數在瀏覽器 bundle 裡是 undefined,結果會是所有前端事件都被標成本機。
   */
  origin: string | undefined;
  /** 本機的逃生開關(CMS_ERROR_ALLOW_LOCAL=1)。見下方 silenced 的說明。 */
  allowLocal?: boolean;
  /** SDK 自己的除錯輸出(CMS_ERROR_DEBUG=1)。 */
  debug?: boolean;
  /** 這份程式碼是哪一版;拿不到就不設(不設比設一個假的好)。 */
  release?: string;
}

/**
 * 判斷「這一組脈絡到底會不會送出事件」。
 *
 * 抽成獨立的匯出函式,是為了讓後台狀態頁能問同一個問題而不必自己再推一次 ——
 * 「後台說在送、實際上沒送」是這種功能最典型的失敗方式,兩邊共用同一個判斷就
 * 不可能不一致。
 */
export function resolveDsn(ctx: ObserveContext): string | undefined {
  const layer = layerOf(ctx.origin);
  /*
   * 本機不送。
   *
   * 不是因為吵 —— 是因為本機的錯誤會和正式站的**混進同一組 issue**。之後看到一筆,
   * 你分不出那是使用者真的遇到了,還是某個人 `next dev` 時自己弄出來的。而錯誤清單
   * 一旦開始說謊,它就不再是可以依賴的東西。
   *
   * 而且本機的例外裡什麼都可能有:測試資料、隨手打的假 email、正在除錯的那組 token,
   * 還有堆疊裡開發機的絕對路徑。那些沒有理由離開這台筆電。
   *
   * 做法是**直接不給 DSN**,不是靠 beforeSend 回 null —— 後者事件已經組好了,只是
   * 最後一刻丟掉;前者連 SDK 的傳輸層都不會建立。
   *
   * 要在本機實測這條線(剛接好、想確認送得出去)就開逃生開關:
   *   pnpm exec wrangler dev --var CMS_ERROR_ALLOW_LOCAL:1
   * 前端沒有對應的開關 —— 要驗前端就另開一個 GlitchTip 專案,別讓它有機會汙染
   * 正式站那一組。
   */
  if (layer === "local" && !ctx.allowLocal) return undefined;
  // `|| undefined` 不是多餘的:wrangler 的 var 與 Next 的建置期字串取代都會給出
  // **空字串**而不是 undefined,而空字串會被 SDK 當成「一個壞掉的 DSN」而印警告。
  // 我們要的是安靜地關掉,不是每次冷啟動都抱怨一次。
  return ctx.dsn?.trim() || undefined;
}

/**
 * 伺服器端(server / edge)在 module load 那一刻讀得到的東西。集中一處,免得四個
 * init 檔各拼各的環境變數字串 —— 拼錯一個字不會有任何錯誤訊息,只會安靜地不送。
 *
 * ⚠️ 名字一律避開 `SENTRY_DSN`,理由見上方 ObserveContext.dsn。
 */
export function serverObserveEnv(): ObserveContext {
  return {
    dsn: process.env.CMS_ERROR_DSN,
    // module load 的那一刻讀不到 D1,所以站台設定裡的 core.siteUrl 還不存在。這個
    // 變數是那一刻的替身:沒設也沒關係 —— 第一個真的要回報東西的 request 會用
    // core.siteUrl 重新校正(見 report.ts 的 resolveReporting)。
    origin: process.env.CMS_ERROR_ORIGIN,
    allowLocal: process.env.CMS_ERROR_ALLOW_LOCAL === "1",
    debug: process.env.CMS_ERROR_DEBUG === "1",
    release: process.env.CMS_ERROR_RELEASE || undefined,
  };
}

export function sentryOptions(ctx: ObserveContext): SentryOptions {
  return {
    // dsn 是 undefined 時 SDK 直接變成 no-op —— 不會報錯,也不會有任何網路流量。
    // GlitchTip 還沒架好、站台沒填、或人在本機,這整套就是靜靜地不存在。
    //
    // ⚠️ 這個 repo 是公開範本,會被 fork。**任何情況下都不要在這裡放一顆預設 DSN** ——
    // 那會讓每一個 fork 出去的站把它的錯誤(連同堆疊裡的資料)送到原作者的收集端。
    // 預設空白 = 整套安靜關閉,是唯一正確的預設值。
    dsn: resolveDsn(ctx),

    /**
     * SDK 自己的除錯輸出。平常關著。
     *
     * 自架的收集端會遇到一種很難查的狀況:錯誤明明發生了,GlitchTip 上卻什麼都沒有 ——
     * 而「沒送出去」和「送出去但被對面丟掉」在我們這邊看起來一模一樣。打開這個,
     * SDK 會把每一次傳輸的結果印出來,兩者立刻分得開。
     *
     * 做成環境變數而不是改程式碼:要用到它的時候通常是正式站出事的時候,那時候最不想
     * 做的事就是為了看一行 log 而重新部署一次。
     */
    debug: ctx.debug ?? false,

    environment: layerOf(ctx.origin),
    release: ctx.release,

    // 這個 CMS 的「PII」具體來說是使用者 email 與 IP。絕對不要打開。
    sendDefaultPii: false,

    // 見檔頭:GlitchTip 不吃這些,開了只是在燒 bundle 大小和頻寬。
    tracesSampleRate: 0,

    // 錯誤全收。單站的量級不需要抽樣,而漏掉的那一筆通常就是要找的那一筆。
    sampleRate: 1,

    beforeSend: (event) => scrubEvent(event),

    /**
     * 不值得吵醒任何人的東西。
     *
     * 這些都不是站台的 bug:使用者切走造成的取消、瀏覽器擴充套件丟進頁面的例外、
     * 還有網路斷掉。留著它們只會讓真正的錯誤淹在雜訊裡,而一個沒有人想看的錯誤
     * 清單等於沒有錯誤清單。
     */
    ignoreErrors: [
      "AbortError",
      "The operation was aborted",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
    ],
  };
}
