import {
  layerOf,
  resolveDsn,
  sentryOptions,
  serverObserveEnv,
  type ObserveLayer,
} from "./sentry-options";

// [core] 不要在客戶站改這個檔 —— 主動回報,以及「DSN 到底從哪來」的唯一決定點。
//
// ## 為什麼需要「主動」回報
//
// instrumentation.ts 的 onRequestError 只接得到**丟到框架邊界**的例外。任何被
// try/catch 接住的東西它都看不到 —— 而這個 repo 裡最貴的幾個故障正好都是那個形狀:
//
//   - src/ext/hooks.ts 的 doAction/applyFilters:每一個 extension 的 hook 失敗都只
//     console.error,HTTP 照樣回 200。裝了三個 extension、其中一個從上週就一直在丟
//     錯,沒有人會知道。
//   - extensions/cron/scheduled.ts 的 runCronTick:合約就是「絕不 throw」。cron 壞掉
//     等於全靜音,只剩 lazy sweep 撐著,而使用者只會覺得「排程發佈好像有點慢」。
//
// 所以凡是「錯誤會被別人接走、但那件事其實很嚴重」的地方,都要在它被接走**之前**
// 經過這裡。
//
// ## DSN 的兩個來源,以及為什麼是兩個
//
// 1. **環境變數 `CMS_ERROR_DSN`(wrangler var)** —— 完整的那一條。SDK 在 module load
//    就綁好,所以連「還沒進到我們任何一行程式碼就炸掉」的請求都收得到。正式站應該
//    設這個。
// 2. **設定 `ext.sentry.dsn`(sentry extension)** —— 免重新部署的那一條。填完存檔就
//    生效,但它要等到這個 isolate 第一次「有人要回報東西」時才綁得起來(D1 只有在
//    request 裡讀得到)。所以它涵蓋所有明確呼叫 reportError 的地方與 onRequestError,
//    但涵蓋不到「綁定之前」的那一瞬間。
//
// 兩者同時存在時**設定優先**:設定是站台管理者剛剛在後台按下去的,環境變數是上一次
// 部署留下的。人剛做的動作應該贏。
//
// 後台狀態頁(extensions/sentry/admin-page.tsx)顯示的就是這裡算出來的東西,不是另外
// 推一次 —— 「後台說在送、實際上沒送」是這種功能最典型的失敗方式。

/** sentry extension 的 id。core 只認得這一個字串,見下方 resolveReporting 的說明。 */
const OBSERVE_EXT_ID = "sentry";

/** DSN 的設定 key(`ext.<extId>.<key>`,secret:true → AES-GCM 加密儲存)。 */
const DSN_SETTING_KEY = `ext.${OBSERVE_EXT_ID}.dsn`;

export type ObserveDsnSource = "settings" | "env" | "none";

export interface ReportingStatus {
  layer: ObserveLayer;
  /** 判定 layer 用的 origin(給後台顯示「我是照哪個網址判的」)。 */
  origin: string | undefined;
  source: ObserveDsnSource;
  /** 現在真的會把事件送出去嗎。false 的原因由 layer + source 一起解釋。 */
  sending: boolean;
}

/**
 * 算出「現在這個站的回報脈絡」。純讀取,不碰 SDK —— 後台狀態頁只要這一半。
 *
 * 為什麼 core 會知道 `ext.sentry.dsn` 這個字串:因為要涵蓋的錯誤(hook 失敗、
 * 框架邊界的例外)發生在 core 裡,而 core 不可能等 extension 的程式碼先跑過一次。
 * 反過來把這顆 DSN 放進 CORE_SETTINGS 也不行 —— 那會讓沒裝這個 extension 的站在
 * 設定頁看到一個孤兒欄位。所以這裡是一條刻意的、只有一個字串寬的接縫。
 *
 * extension 沒裝或停用時完全不讀那個 key。這不只是禮貌:secret 設定的解密判定是
 * 依「已啟用 extension 宣告的 secret 欄位」做的,停用狀態下 getSetting 會原封不動
 * 回傳密文 —— 那會變成一顆看起來有值、實際上是亂碼的 DSN。
 */
export async function resolveReporting(): Promise<
  ReportingStatus & { dsn: string | undefined; debug: boolean; release: string | undefined }
> {
  const env = serverObserveEnv();
  let dsn = "";
  let source: ObserveDsnSource = "none";
  let origin = env.origin;

  try {
    const { getSetting } = await import("@/lib/settings");
    // core.siteUrl 不管 extension 裝沒裝都讀 —— 它是站台唯一權威的「我是誰」。
    const siteUrl = await getSetting<string>("core.siteUrl", "");
    if (typeof siteUrl === "string" && siteUrl.trim()) origin = siteUrl.trim();

    const { getExtRuntime } = await import("@/ext/loader");
    const rt = await getExtRuntime();
    if (rt.byId(OBSERVE_EXT_ID)) {
      const stored = await getSetting<string>(DSN_SETTING_KEY, "");
      if (typeof stored === "string" && stored.trim()) {
        dsn = stored.trim();
        source = "settings";
      }
    }
  } catch (e) {
    // D1 讀不到不該讓錯誤回報自己變成錯誤。退回環境變數那條路,照樣能運作。
    console.error("[observe] failed to read reporting settings", e);
  }

  if (!dsn && env.dsn?.trim()) {
    dsn = env.dsn.trim();
    source = "env";
  }

  const ctx = {
    dsn: dsn || undefined,
    origin,
    allowLocal: env.allowLocal,
    debug: env.debug,
    release: env.release,
  };
  const effective = resolveDsn(ctx);

  return {
    layer: layerOf(origin),
    origin,
    // source 說的是「有沒有人給了 DSN」,sending 說的是「那顆 DSN 現在會不會被用」。
    // 兩件事分開報,後台才講得出「填了但因為判定成本機所以沒在送」這種狀態 ——
    // 那正是最容易讓人以為壞掉的情況。
    source,
    sending: Boolean(effective),
    dsn: effective,
    debug: env.debug ?? false,
    release: env.release,
  };
}

/**
 * SDK 本體是**動態**載入的,不是檔頭的靜態 import。
 *
 * 理由:這個模組被 src/ext/hooks.ts 靜態引用,而 hooks 又被 src/ext/loader.ts 引用 ——
 * 也就是說「@sentry/nextjs 進不進 module graph」等同於「整個 extension 系統的靜態
 * 相依鏈裡有沒有它」。@sentry/nextjs 的 server build 會拉 next/constants 之類的東西,
 * 而 vitest 的 workers pool 載不動那些(整個 extension 相關的測試會一起倒)。
 *
 * 而且這樣有個好處是本來就想要的:**沒設 DSN 的站根本不會載入 SDK**。下面每個
 * 用得到它的地方都在確認「真的有東西要送」之後才呼叫這個函式。
 */
type SentrySdk = typeof import("@sentry/nextjs");

function loadSdk(): Promise<SentrySdk> {
  return import("@sentry/nextjs");
}

/**
 * 「上一次失敗過」的旗標。init 若在這個 runtime 炸開(例如 SDK 在 workerd 上碰到
 * 不支援的東西),不該讓**每一個**後續錯誤都再試一次 —— 那會把一次故障放大成
 * 每筆錯誤兩次故障。試一次就認了,log 留著。
 */
let bindFailed = false;

/**
 * 確保這個 isolate 綁著正確的 client,然後回報狀態。
 *
 * 為什麼可以重複呼叫 `Sentry.init`:init 的語意就是「建立 client 並綁到目前的 scope」。
 * 這裡先比對已綁的 DSN,只有真的不同才重綁 —— 所以正常情況下每個 isolate 只會 init
 * 一次(module load 一次,或第一個 request 一次),不是每個請求一次。
 */
export async function ensureReporting(): Promise<ReportingStatus> {
  const resolved = await resolveReporting();
  const status: ReportingStatus = {
    layer: resolved.layer,
    origin: resolved.origin,
    source: resolved.source,
    sending: resolved.sending && !bindFailed,
  };

  // 早退在 SDK 載入之前:沒 DSN(新站的預設狀態)就連 import 都不發生。
  if (!resolved.dsn || bindFailed) return status;

  try {
    const Sentry = await loadSdk();
    const current = Sentry.getClient()?.getOptions().dsn;
    if (current === resolved.dsn) return status;

    Sentry.init(
      sentryOptions({
        dsn: resolved.dsn,
        origin: resolved.origin,
        // 走到這裡代表 resolveDsn 已經放行了。再算一次 allowLocal 只是重複同一個
        // 判斷,而且會讓「後台顯示的」與「實際綁的」多一個可能不一致的地方。
        allowLocal: true,
        debug: resolved.debug,
        release: resolved.release,
      }),
    );
  } catch (e) {
    bindFailed = true;
    status.sending = false;
    console.error("[observe] Sentry.init failed; error reporting is off", e);
  }
  return status;
}

/**
 * 附在事件上的分類標籤。
 *
 * 刻意只收 string,而且刻意不叫 `data` —— tag 是拿來在 GlitchTip 上篩選和分組的,
 * 不是拿來塞內容的。任何使用者資料(email、內容本身、設定值)都不該出現在這裡:
 * 錯誤追蹤系統的存取控制永遠比正式資料庫鬆。
 */
export type ReportTags = Record<string, string>;

/**
 * 回報一個錯誤。
 *
 * **刻意不 console.error** —— 這個 repo 既有的每一個 catch 都已經印過一次了
 * (`console.error("[hook:…]", e)` 之類),再印一次只會讓同一件事在 log 裡出現兩遍,
 * 而查 log 的人會以為發生了兩次。log 由呼叫端負責,這裡只負責送出去。
 *
 * 整支函式**絕不 throw**:監控是旁觀者,不是流程的一部分。回報失敗不該讓原本
 * 只是「某個 hook 出錯」的請求變成 500。
 */
export async function reportError(
  error: unknown,
  tags: ReportTags,
): Promise<void> {
  try {
    const status = await ensureReporting();
    if (!status.sending) return;
    const Sentry = await loadSdk();
    Sentry.captureException(error, { tags });
  } catch (e) {
    console.error("[observe] failed to report an error", e);
  }
}

/**
 * 送出一筆事件,並**等它真的離開這台機器**,然後回傳 event id。
 *
 * 和 reportError 的差別只有「等」這一件事,但那一件事在 Worker 上是關鍵:isolate 在
 * 回應送出後隨時可能被回收,而 SDK 的傳輸是非同步的 —— 不 flush 的話事件會跟著
 * isolate 一起消失,而且不會留下任何跡象。
 *
 * 平常的錯誤回報不值得為此多等(那會把監控的成本加到使用者的請求上),所以只有
 * 兩種呼叫端該用這一支:後台的「送測試事件」按鈕,以及 cron 那條沒有後續請求可以
 * 搭便車的路徑。
 *
 * 回傳 null = 沒有送(沒設定、或判定成本機)。丟出例外 = 真的送不出去,呼叫端要
 * 自己決定怎麼解釋 —— 這一支刻意**不吞例外**,因為它的呼叫端就是要診斷失敗。
 */
export async function reportAndFlush(
  error: unknown,
  tags: ReportTags,
  timeoutMs = 3000,
): Promise<string | null> {
  const status = await ensureReporting();
  if (!status.sending) return null;
  const Sentry = await loadSdk();
  const eventId = Sentry.captureException(error, { tags });
  await Sentry.flush(timeoutMs);
  return eventId;
}

/**
 * 跑一段「失敗必須被看見、而且失敗要繼續往上丟」的程式碼。
 *
 * 回報之後**原樣重新丟出**,不吞掉:呼叫端的錯誤處理邏輯不該因為我們裝了監控就
 * 改變行為。
 */
export async function reportAndRethrow<T>(
  tags: ReportTags,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await reportError(error, tags);
    throw error;
  }
}
