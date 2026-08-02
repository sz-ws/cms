import { resolveReporting } from "@/lib/observe/report";
import { TestEventButton } from "./TestEventButton";

// 錯誤追蹤 extension 的 adminPage —— 「到底有沒有在送」這一個問題的答案。
//
// 這一頁存在的理由:錯誤回報是少數幾種「設錯了完全沒有症狀」的功能。DSN 少一個字、
// 站台網址沒填(於是被判成本機而靜音)、只設了伺服器端卻以為前端也有 —— 三種都長得
// 一模一樣:什麼都沒發生。所以這頁把每一個會讓事件送不出去的環節分開列,而不是給
// 一顆「已啟用 ✓」的綠燈。
//
// 狀態全部來自 core 的 resolveReporting() —— 和真正決定要不要送的是同一個函式。
// 後台自己再推一次的話,「頁面說在送、實際上沒送」只是遲早的事。
//
// 語言:extension 自帶 UI 不進 core 字典(MessageKey 是封閉聯集,extension 加不了鍵),
// 跟隨本 repo 既有 code extension 的作法(cron / newebpay 皆 zh-Hant)。

const CARD =
  "rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

const PILL =
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium";
const PILL_GREEN =
  "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)] shadow-[inset_0_0_0_1px_rgba(16,145,90,0.16)]";
const PILL_AMBER =
  "bg-amber-500/10 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)]";
const PILL_NEUTRAL = "bg-black/[0.04] text-black/55";

const LAYER_LABEL: Record<string, string> = {
  production: "正式站",
  staging: "預覽 / 測試站",
  local: "本機",
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
      <span className="w-28 shrink-0 text-[12.5px] text-black/45">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-2 text-[13px] text-black/70">
        {children}
      </span>
    </div>
  );
}

export async function SentryAdminPage() {
  const status = await resolveReporting();

  // 前端那顆 DSN 是**建置期**用字串取代進去的,所以這一行在 server component 裡讀到的
  // 就是前端 bundle 裡的那一顆(同一次 build)。寫成完整字面形式是必要的,拆開會拿到
  // undefined —— 理由見 instrumentation-client.ts。
  const hasClientDsn = Boolean(process.env.NEXT_PUBLIC_CMS_ERROR_DSN);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          錯誤追蹤
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          把沒接住的例外、失敗的 extension hook 與失敗的 cron tick
          送到自架的 GlitchTip(或任何說 Sentry 協定的收集端)。DSN
          留空就是整套安靜關閉 —— 沒有任何網路流量,也不會有警告。
        </p>
      </header>

      {/* 狀態:把每一個會讓事件送不出去的環節分開列。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          狀態
        </h2>
        <div className="flex flex-col gap-2.5">
          <Row label="伺服器端 DSN">
            {status.source === "settings" && (
              <>
                <span className={`${PILL} ${PILL_GREEN}`}>已設定</span>
                <span className="text-black/50">
                  來自這個 extension 的設定(加密儲存,存檔即生效)。
                </span>
              </>
            )}
            {status.source === "env" && (
              <>
                <span className={`${PILL} ${PILL_GREEN}`}>已設定</span>
                <span className="text-black/50">
                  來自環境變數{" "}
                  <code className="font-mono text-[12px]">CMS_ERROR_DSN</code>
                  。下方填了設定值的話,設定值優先。
                </span>
              </>
            )}
            {status.source === "none" && (
              <>
                <span className={`${PILL} ${PILL_NEUTRAL}`}>未設定</span>
                <span className="text-black/50">
                  到設定頁的 Extensions 區填「錯誤追蹤
                  DSN」。整套目前是關閉的。
                </span>
              </>
            )}
          </Row>

          <Row label="環境層級">
            <span className={`${PILL} ${PILL_NEUTRAL}`}>
              {LAYER_LABEL[status.layer] ?? status.layer}
            </span>
            {status.origin ? (
              <code className="break-all font-mono text-[12px] text-black/50">
                {status.origin}
              </code>
            ) : (
              <span className="text-amber-700">
                判不出站台網址(設定頁 General 區的 Site URL 是空的)——
                於是被當成本機,事件不會送出。
              </span>
            )}
          </Row>

          <Row label="目前">
            {status.sending ? (
              <>
                <span className={`${PILL} ${PILL_GREEN}`}>送出中</span>
                <span className="text-black/50">
                  事件會標成 <code className="font-mono text-[12px]">{status.layer}</code>
                  ,GlitchTip 上可以用它篩選。
                </span>
              </>
            ) : (
              <>
                <span className={`${PILL} ${PILL_AMBER}`}>不送</span>
                <span className="text-black/50">
                  {status.source === "none"
                    ? "還沒有 DSN。"
                    : "有 DSN,但這一層是本機 —— 本機的錯誤會和正式站的混進同一組 issue,而且堆疊裡有開發機的絕對路徑,所以預設不送。要在本機實測就加 CMS_ERROR_ALLOW_LOCAL=1。"}
                </span>
              </>
            )}
          </Row>

          <Row label="瀏覽器端">
            {hasClientDsn ? (
              <>
                <span className={`${PILL} ${PILL_GREEN}`}>已設定</span>
                <span className="text-black/50">
                  這次建置有帶到前端 DSN。
                </span>
              </>
            ) : (
              <>
                <span className={`${PILL} ${PILL_NEUTRAL}`}>未設定</span>
                <span className="text-black/50">
                  前端的錯誤(編輯器、上傳、passkey
                  註冊)不會被記錄。這一顆只能是建置期的環境變數{" "}
                  <code className="font-mono text-[12px]">
                    NEXT_PUBLIC_CMS_ERROR_DSN
                  </code>
                  —— 瀏覽器讀不到 D1,所以上面那個設定欄位對它無效,而且換了要重新
                  build。
                </span>
              </>
            )}
          </Row>
        </div>
      </section>

      {/* 測試:走完整的真實路徑,不是驗證 DSN 長得像不像。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          送一筆測試事件
        </h2>
        <p className="mb-4 text-[13px] leading-relaxed text-black/55">
          從伺服器端送出一筆刻意製造的錯誤,走的是和真實錯誤完全相同的路徑(同一個
          client、同一組清理規則)。成功會回傳 event
          id,拿去 GlitchTip 上就找得到那一筆。
        </p>
        <TestEventButton disabled={status.source === "none"} />
      </section>

      {/* 涵蓋範圍:講清楚哪些錯誤走得到、哪些走不到。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          收得到什麼
        </h2>
        <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-black/65">
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">·</span>
            <span>
              後台與公開站沒接住的例外(server component、route handler、
              middleware)。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">·</span>
            <span>
              失敗的 extension hook。這些原本只印在 Worker
              log 裡:HTTP 照樣回 200、後台照樣顯示存檔成功,只是 webhook
              沒送出去、通知信沒寄。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">·</span>
            <span>
              失敗的 cron tick。這條路不經過 Next.js,所以它自己 init
              一次(見 extensions/sentry/scheduled.ts);
              tick 的「絕不 throw」合約沒有改變,只是失敗多了一個看得到的地方。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">·</span>
            <span>
              瀏覽器端的錯誤 —— 但只有在建置時帶了{" "}
              <code className="font-mono text-[12px]">
                NEXT_PUBLIC_CMS_ERROR_DSN
              </code>{" "}
              的情況下。
            </span>
          </li>
        </ul>
        <p className="mt-4 text-[12.5px] leading-relaxed text-black/45">
          送出前會做刪去法清理:cookie、authorization / 簽章 header、請求內文與
          query string 一律拿掉。這個 CMS
          什麼資料都碰得到,而一份夠詳細的錯誤報告本身就是一次外洩 ——
          錯誤追蹤系統的存取控制永遠比正式資料庫鬆。tracing 與 session replay
          全關(GlitchTip 不吃,而錄下後台畫面等於錄下每一次登入輸入)。
        </p>
      </section>
    </div>
  );
}
