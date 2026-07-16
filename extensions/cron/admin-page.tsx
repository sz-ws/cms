import { getSetting } from "@/lib/settings";
import { relativeTimeWords } from "@/lib/relative-time";

// cron extension 的 adminPage —— 補「裝完零引導」缺口(handoff-2026-07-11-cron-gaps #1):
// tick 觀測(ext.cron.lastTick)+ 驗簽 endpoint + companion worker 三步部署指引。
//
// 語言:extension 自帶 UI 不進 core 字典(MessageKey 是封閉聯集,extension 加不了鍵),
// 跟隨本 extension 既有語言(description / worker README 皆 zh-Hant)。

const CARD =
  "rounded-[14px] bg-white px-6 py-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

const PILL = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium";
const PILL_GREEN =
  "bg-[rgba(16,145,90,0.10)] text-[rgb(18,124,88)] shadow-[inset_0_0_0_1px_rgba(16,145,90,0.16)]";
const PILL_AMBER =
  "bg-amber-500/10 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)]";
const PILL_RED =
  "bg-red-600/10 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.16)]";
const PILL_NEUTRAL = "bg-black/[0.04] text-black/55";

// worker 範本 crons = 每分鐘("* * * * *");超過 5 分鐘沒 tick 視為「可能停跳」。
const STALE_MS = 5 * 60_000;

const ENDPOINT_PATH = "/api/callback/cron:tick/cron";

// Date.now() 抽成獨立函式 —— 元件 body 內直呼會被 react-hooks/purity 擋下
// (Server Component 也照 PascalCase 啟發式判定;同 admin/account/page.tsx 手法)。
function requestTimestamp(): number {
  return Date.now();
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
      <span className="w-32 shrink-0 text-[12.5px] text-black/45">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-2 text-[13px] text-black/70">
        {children}
      </span>
    </div>
  );
}

export async function CronAdminPage() {
  const [secret, lastTick, siteUrl] = await Promise.all([
    getSetting<string>("ext.cron.secret", ""),
    getSetting<number | null>("ext.cron.lastTick", null),
    getSetting<string>("core.siteUrl", ""),
  ]);
  const now = requestTimestamp();
  const hasSecret = Boolean(secret);
  const stale = typeof lastTick === "number" && now - lastTick >= STALE_MS;
  const endpoint = siteUrl
    ? `${siteUrl.replace(/\/+$/, "")}${ENDPOINT_PATH}`
    : ENDPOINT_PATH;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          Cron
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          分鐘級準時排程的驗簽入口。錶(定時器)活在外部的 companion
          worker;它每分鐘對下方 endpoint 送一個帶 HMAC 簽章的
          tick,催動到期任務掃描。worker 掛掉不會壞 —— 排程退回 core 的 lazy
          sweep 節奏,到期任務最終仍會被處理。
        </p>
      </header>

      {/* 狀態:secret 在否 + 最後 tick(worker 是否真的在跳)。 */}
      <section className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          狀態
        </h2>
        <div className="flex flex-col gap-2.5">
          <Row label="Signing secret">
            {hasSecret ? (
              <span className={`${PILL} ${PILL_GREEN}`}>已設定</span>
            ) : (
              <>
                <span className={`${PILL} ${PILL_RED}`}>未設定</span>
                <span className="text-black/50">
                  入口關閉(fail-closed,拒收所有 tick)。到設定頁的
                  Extensions 區填「Cron signing secret」。
                </span>
              </>
            )}
          </Row>
          <Row label="最後 tick">
            {typeof lastTick === "number" ? (
              <>
                <span className={`${PILL} ${stale ? PILL_AMBER : PILL_GREEN}`}>
                  {stale ? "可能停跳" : "運作中"}
                </span>
                <span>{relativeTimeWords(lastTick, now, "zh-Hant")}</span>
                <span className="text-[12px] tabular-nums text-black/40">
                  {new Date(lastTick).toLocaleString("zh-TW", { hour12: false })}
                </span>
                {stale && (
                  <span className="text-black/50">
                    超過 5 分鐘沒收到 —— 檢查 companion worker 是否還在跑。
                  </span>
                )}
              </>
            ) : (
              <>
                <span className={`${PILL} ${PILL_NEUTRAL}`}>從未收到</span>
                <span className="text-black/50">
                  lazy sweep 仍保底,只是準時度停在「有人瀏覽 admin 時」。
                </span>
              </>
            )}
          </Row>
        </div>
      </section>

      {/* Endpoint:worker 要打的 URL + 簽章配方。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          Endpoint
        </h2>
        <p className="mb-3 text-[13px] leading-relaxed text-black/55">
          companion worker 對這個 URL 送 <code className="font-mono text-[12px]">POST</code>
          ,簽章放 <code className="font-mono text-[12px]">x-signature</code> header
          (對整段 raw body 的 HMAC-SHA-256,hex 編碼),兩端共用同一個 signing
          secret。
        </p>
        <code className="block overflow-x-auto rounded-[10px] bg-black/[0.04] px-4 py-3 font-mono text-[13px] text-black/85">
          POST {endpoint}
        </code>
        {!siteUrl && (
          <p className="mt-2 text-[12px] text-amber-700">
            尚未設定 Site URL(設定頁 General 區)—— 上面只顯示相對路徑,worker
            的 SITE_URL 請自行帶站台 origin。
          </p>
        )}
      </section>

      {/* 三步部署:鏡射 extensions/cron/worker/README.md,別讓兩份漂移。 */}
      <section className={CARD}>
        <h2 className="mb-2 text-[15px] font-semibold tracking-[-0.01em] text-black/85">
          三步啟用
        </h2>
        <p className="mb-4 text-[13px] leading-relaxed text-black/55">
          worker 範本在 CMS repo 的{" "}
          <code className="rounded bg-black/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-black/80">
            extensions/cron/worker/
          </code>
          ,單獨 deploy,不隨 CMS 部署(詳見該目錄 README)。
        </p>
        <ol className="flex flex-col gap-2 text-[13px] leading-relaxed text-black/65">
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">1.</span>
            <span>
              在設定頁 Extensions 區填「Cron signing
              secret」(隨機長字串;加密儲存)。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">2.</span>
            <span>
              部署 worker:填 <code className="font-mono text-[12px]">wrangler.jsonc</code>{" "}
              的 SITE_URL、
              <code className="font-mono text-[12px]">wrangler secret put CRON_SECRET</code>
              (同一個值)、
              <code className="font-mono text-[12px]">wrangler deploy</code>。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-black/35">3.</span>
            <span>等一分鐘,回來看上方「最後 tick」轉綠。</span>
          </li>
        </ol>
      </section>
    </div>
  );
}
