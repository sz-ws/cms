import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "./db";
import { getDB } from "./cf";
import { contents, extJobs, storageHistory } from "./schema";
import { getSetting, setSettings } from "./settings";
import { indexContentEntry } from "./search";
import { revalidateContent } from "@/ext/dx/cache-invalidate";

// Core jobs surface（v1）+ scheduled publishing。
//
// 這是「core 排程任務」的單一有界模組。目前只有一支核心任務 `publish-due`
// （把到期的排程草稿轉為已發佈）。任務以三種方式觸發:
//   1. Lazy fallback：admin layout（server component）每次 render 呼叫一次
//      maybeRunJobs()，內部節流到最多每 60 秒掃一次（見下方 SWEEP_INTERVAL_MS）。
//      這是「無 cron 環境」下的保底機制,靠 admin 有人在看時順手推進。
//   2. Manual：POST /api/jobs/run（requireAuth("admin") + assertSameOrigin）
//      直接跑 runDueJobs 並回傳每支任務結果,供手動催發 / debug。
//   3. Cron：Cloudflare cron trigger → `scheduled` handler → 簽章回呼
//      `POST /api/callback/cron:tick/cron` → cron extension 的 provider 驗簽後
//      呼叫 runDueJobs（見下方 CRON 接線）。
//
// ── CRON 接線(已查證,勿臆測)────────────────────────────────────────────
// @opennextjs/cloudflare 1.20.1 產生的入口 `.open-next/worker.js` 只
// `export default { fetch }`,不含 `scheduled` handler。但**它的 CLI 完全不讀、
// 不驗證、不覆寫 wrangler.jsonc 的 `main` 欄位**(已讀原始碼確認,並以
// `wrangler deploy --dry-run` 實測)。所以接法是:`main` 指到 repo 根的
// `custom-worker.ts`,由它原樣 re-export 產出物的 fetch 與 Durable Object class,
// 只多掛一個 `scheduled` —— OpenNext 的輸出一個 byte 都沒被改動,不違反硬規則。
//
// **core 本身仍然只有 lazy sweep**:上面第 3 條的 signing secret 與 tick 入口都住在
// cron extension(extensions/cron/)。core 沒有、也不會有自己的 cron secret。
// scheduled handler 沒有 request context(getCloudflareContext() 會 throw),
// 所以它不直接呼叫本模組,而是走既有的 unified callback ingress —— 驗簽 / rate limit /
// 錯誤語意全部沿用同一份已驗證過的程式碼,不會多開一條繞過驗簽的入口。
// 實作見 extensions/cron/scheduled.ts;cron extension 沒裝 / 沒啟用 / 沒設密鑰時
// handler 安靜 no-op,退回 lazy sweep 節奏。
//
// 排程頻率在 wrangler.jsonc 的 `triggers.crons`(預設每分鐘)。publish-due 的
// WHERE 子句本身冪等,cron 與 lazy 併發最壞只是重跑一次。
//
// ── Extension 貢獻的 job(docs/spec-extension-jobs.md,CORE_API 1.10.0)───────
// 見下方 `ext-jobs` core job:併入本模組既有的 CORE_JOBS 陣列 / runDueJobs 迭代,
// 沿用同一組觸發路徑(lazy sweep / manual / cron:tick),不新增任何觸發機制。
//
// ── D1 用量預警(migrations/0015_storage_history.sql)───────────────────────
// 見下方 `storage-probe` core job:同樣併入 CORE_JOBS,只讀 D1 回的 `size_after`
// 由 SQLite trigger 維護的小表,不做任何全表統計(理由見該處註解)。

/** 單支任務執行結果。processed = 本次實際處理的列數(如 publish-due 轉發的筆數)。 */
export interface JobRunResult {
  ok: boolean;
  detail?: string;
  processed?: number;
}

/** core job 介面。id 於 core-jobs 內唯一,亦用於 bookkeeping key。 */
export interface CoreJob {
  id: string;
  run(now: number): Promise<JobRunResult>;
}

/** runDueJobs 回傳的逐任務報告(結果 + 任務 id)。 */
export type JobRunReport = JobRunResult & { id: string };

/** lazy 掃描節流間隔:兩次 sweep 至少相隔此毫秒數。 */
const SWEEP_INTERVAL_MS = 60_000;

/** settings key:某任務最後一次執行的 epoch ms。 */
const lastRunKey = (jobId: string): string => `core.jobs.lastRun.${jobId}`;
/** settings key:lazy fallback 最後一次 sweep 的 epoch ms(節流用)。 */
const LAST_SWEEP_KEY = "core.jobs.lastSweep";
/**
 * cron extension 每次成功跑完的 heartbeat；新鮮時 lazy fallback 不重跑同一批 job。
 *
 * 寫的人是 extensions/cron/provider.ts 的 LAST_TICK_KEY(handleCallback 驗簽後
 * set)。core 只讀不寫,兩邊靠這個字串字面量對上 —— core 沒有 import extension 的
 * 權利,所以改名要兩處一起改。extension 沒裝 / 沒啟用時這個 key 永遠是 0,
 * 也就是 fail-open:讀不到 heartbeat 就當 cron 不健康,lazy sweep 照跑。壞掉的方向
 * 是「多跑一次 sweep」而不是「job 停擺」。
 */
const LAST_CRON_TICK_KEY = "ext.cron.lastTick";
/**
 * 容忍一次 cron jitter；超過兩個排程週期沒 heartbeat 才啟動 fallback。
 *
 * 這裡的「兩個週期」= 2 分鐘,前提是 cron trigger 至少每 2 分鐘觸發一次 ——
 * wrangler.jsonc 出貨的 `triggers.crons` 是每分鐘一次的 `* * * * *`,成立。改成
 * 每 5 分鐘一次(該檔註解裡「要更省可調成」的那個值)之後,每 5 分鐘裡有 3 分鐘
 * heartbeat 是過期的,這道 gate 大多數時間形同不存在:lazy sweep 會照它自己的
 * 60 秒節流繼續跑。要放寬排程頻率就要連這個窗一起放大。
 */
const CRON_HEALTH_WINDOW_MS = SWEEP_INTERVAL_MS * 2;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- publish-due:到期排程草稿 → 已發佈 ─────────────────────────────────────
//
// 選出 status='draft' 且 publish_at 非 NULL 且 <= now 的列;逐列:
//   1. 原生 UPDATE 翻 status='published'、updated_at=now、publish_at=NULL
//      （條件式 WHERE 仍含 status/publish_at,故併發雙跑時第二次影響 0 列 → 冪等;
//       RETURNING 為空即代表已被另一次執行處理,略過 hook/index,避免重複副作用）。
//   2. 觸發 `content:updated` hook,payload 形狀與 CoreContentProvider 完全一致
//      （{ type, id, data }，data 為解析後的 JSON document）。
//   3. 重建該列 FTS 索引(indexContentEntry;best-effort,同 provider 哲學:索引失敗
//      絕不連累主流程)。
//   4. 精準失效 public content cache(revalidateContent;guard 於函式內)。
//
// 刻意「不」重跑 field validation:排程發佈只是狀態轉換,內容在寫入時已驗過;原生
// row update + 明確的 hook/index/invalidate 呼叫即可,避免重複驗證成本與其副作用。

interface DueRow {
  id: string;
  type: string;
  /** migrations/0011:FTS 重新索引要帶 locale(每個 locale 列各自獨立排程)。 */
  locale: string;
  data: string;
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      return j as Record<string, unknown>;
    }
  } catch {
    // 損壞的 JSON:以空 document 續行(索引/hook 拿到空 data,不阻斷發佈)。
  }
  return {};
}

const publishDueJob: CoreJob = {
  id: "publish-due",
  async run(now: number): Promise<JobRunResult> {
    const due: DueRow[] = await db()
      .select({
        id: contents.id,
        type: contents.type,
        locale: contents.locale,
        data: contents.data,
      })
      .from(contents)
      .where(
        and(
          eq(contents.status, "draft"),
          isNotNull(contents.publishAt),
          lte(contents.publishAt, now),
          // 公開表單的收件列**永遠**不得被排程發佈碰到(見 src/lib/submissions.ts)。
          // 兩層保證,缺一不可:
          //   結構層 —— 匿名提交走 sanitizePublicCreateBody,publishAt 不是宣告欄位
          //     故一律被剝除,收件列的 publish_at 恆為 NULL,本 WHERE 的第二個條件
          //     就已經選不到它。
          //   明示層 —— 下面這句。萬一有人(手改 DB、未來某條 admin 路徑)真的替一筆
          //     收件列填了 publish_at,它仍然不會被翻成 published 而外洩到公開站。
          //     「客戶的私人詢問被自動發佈上網」是隱私事故,不是 bug,所以不靠推論。
          sql`NOT EXISTS (SELECT 1 FROM content_submissions cs WHERE cs.content_id = ${contents.id})`,
        ),
      );

    let processed = 0;
    for (const row of due) {
      // 條件式翻轉:併發雙跑時,已被處理的列(status 已 published 或 publish_at 已清)
      // 不再匹配 → RETURNING 空 → 略過,確保 hook/index 不重複觸發。
      const flipped = await db()
        .update(contents)
        .set({ status: "published", updatedAt: now, publishAt: null })
        .where(
          and(
            eq(contents.id, row.id),
            eq(contents.status, "draft"),
            isNotNull(contents.publishAt),
          ),
        )
        .returning({ id: contents.id });
      if (flipped.length === 0) continue;

      processed++;
      const data = parseData(row.data);

      // hook:與 CoreContentProvider.update 同形狀 payload。doAction 內部已逐 handler
      // catch,不會 throw;仍以 try/catch 圍住 runtime 取得過程(best-effort)。
      try {
        const { getExtRuntime } = await import("@/ext/loader");
        const rt = await getExtRuntime();
        await rt.hooks.doAction("content:updated", {
          type: row.type,
          id: row.id,
          data,
        });
      } catch (e) {
        console.error("[jobs:publish-due] hook dispatch failed", row.id, e);
      }

      // FTS 重建(best-effort,同 CoreContentProvider.index 哲學)。
      try {
        await indexContentEntry(row.id, row.type, row.locale, data);
      } catch (e) {
        console.error("[jobs:publish-due] reindex failed", row.id, e);
      }

      // public content cache 精準失效(guard 於 revalidateContent 內)。
      revalidateContent(row.type);
    }

    return { ok: true, processed };
  },
};

// ---- ext-jobs:extension 貢獻的週期性 / 一次性任務(docs/spec-extension-jobs.md)──
//
// 三段:
//   1. Reconcile:enabled extension 的 `jobs[]` 中有 `every` 者為宣告集,與
//      ext_jobs 表 `kind='recurring'` 列 diff —— 缺補插(首輪 run_at =
//      now + every*60_000,不立即執行)、多的刪(extension 停用或不再宣告)。
//      `every` 變了不動既有 run_at(下輪 claim 時以新宣告值推進,避免每 sweep 改寫)。
//   2. Claim:到期列(status='pending' AND run_at<=now)逐列 compare-and-set——
//      0 列受影響代表被併發 sweep 搶走,略過(at-most-once per attempt)。
//   3. 執行:recurring 失敗只記 last_error,本輪結束,不重試不補跑;once 失敗走
//      退避(RETRY_BACKOFF_MS)+ attempts 累加,滿 3 次轉 dead(留檔觀測,不再撿起)。
// 逐 job try/catch 隔離(同 publish-due 哲學),絕不中斷其他到期列。

const RETRY_BACKOFF_MS = 5 * 60_000;

interface ExtJobRow {
  id: string;
  extId: string;
  jobId: string;
  kind: "once" | "recurring";
  runAt: number;
  payload: string | null;
  attempts: number;
  status: "pending" | "dead";
}

/** payload JSON.parse 失敗以 null 續行(同 parseData 哲學);recurring 恆為 null。 */
function parsePayload(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const extJobsJob: CoreJob = {
  id: "ext-jobs",
  async run(now: number): Promise<JobRunResult> {
    // workers pool 地雷:loader/services 只能在函式內 dynamic import
    // (publish-due 內已有完全相同的前例,照抄)。
    const { getExtRuntime } = await import("@/ext/loader");
    const { buildProviderRegistry, scopedServices } = await import(
      "@/ext/services"
    );
    const rt = await getExtRuntime();

    // ---- 1. Reconcile:週期性宣告 ↔ 表 ----
    interface Declared {
      extId: string;
      jobId: string;
      every: number;
    }
    const declared: Declared[] = [];
    for (const ext of rt.enabled) {
      for (const job of ext.jobs ?? []) {
        if (job.every !== undefined) {
          declared.push({ extId: ext.id, jobId: job.id, every: job.every });
        }
      }
    }
    const key = (extId: string, jobId: string): string =>
      `${extId}\u0000${jobId}`;
    const declaredMap = new Map(
      declared.map((d) => [key(d.extId, d.jobId), d]),
    );

    const existingRecurring = await db()
      .select({ id: extJobs.id, extId: extJobs.extId, jobId: extJobs.jobId })
      .from(extJobs)
      .where(eq(extJobs.kind, "recurring"));
    const existingKeys = new Set(
      existingRecurring.map((r) => key(r.extId, r.jobId)),
    );

    // 缺 → INSERT(首輪從現在起算,不立即執行)。onConflictDoNothing:併發雙 sweep
    // 可能同時通過 existingKeys 檢查,partial unique(ext_id, job_id WHERE recurring)
    // 會擋第二筆 —— 吞衝突而非讓整支 ext-jobs 這輪報錯。
    for (const d of declared) {
      if (existingKeys.has(key(d.extId, d.jobId))) continue;
      await db()
        .insert(extJobs)
        .values({
          id: crypto.randomUUID(),
          extId: d.extId,
          jobId: d.jobId,
          kind: "recurring",
          runAt: now + d.every * 60_000,
          payload: null,
          attempts: 0,
          status: "pending",
          lastRun: null,
          lastError: null,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
    // 多(extension 停用或不再宣告)→ DELETE。
    for (const row of existingRecurring) {
      if (!declaredMap.has(key(row.extId, row.jobId))) {
        await db().delete(extJobs).where(eq(extJobs.id, row.id));
      }
    }

    // ---- 2 + 3. Claim + 執行 ----
    const due: ExtJobRow[] = await db()
      .select({
        id: extJobs.id,
        extId: extJobs.extId,
        jobId: extJobs.jobId,
        kind: extJobs.kind,
        runAt: extJobs.runAt,
        payload: extJobs.payload,
        attempts: extJobs.attempts,
        status: extJobs.status,
      })
      .from(extJobs)
      .where(and(eq(extJobs.status, "pending"), lte(extJobs.runAt, now)));

    let processed = 0;
    let failed = 0;

    if (due.length > 0) {
      // 每 sweep 建一次 registry(避免每 job 重建 createServices)。
      const registry = buildProviderRegistry(rt);
      await registry.resolveActive();

      for (const row of due) {
        if (row.kind === "recurring") {
          const d = declaredMap.get(key(row.extId, row.jobId));
          // 未宣告:同輪 reconcile 已把不再宣告的列刪除,理論上不會到這裡;防禦性略過。
          if (!d) continue;

          const claimed = await db()
            .update(extJobs)
            .set({ runAt: now + d.every * 60_000, lastRun: now })
            .where(and(eq(extJobs.id, row.id), eq(extJobs.runAt, row.runAt)))
            .returning({ id: extJobs.id });
          if (claimed.length === 0) continue; // 被併發 sweep 搶走

          const handler = rt
            .byId(row.extId)
            ?.jobs?.find((j) => j.id === row.jobId);
          if (!handler) {
            // 理論上不會發生(見上);仍留痕,recurring 無 dead 狀態可標。
            failed++;
            await db()
              .update(extJobs)
              .set({ lastError: "handler not found" })
              .where(eq(extJobs.id, row.id));
            continue;
          }

          try {
            const services = scopedServices(row.extId, rt.hooks, registry);
            await handler.run(services, null, now);
            processed++;
            await db()
              .update(extJobs)
              .set({ lastError: null })
              .where(eq(extJobs.id, row.id));
          } catch (e) {
            processed++;
            failed++;
            await db()
              .update(extJobs)
              .set({ lastError: errorMessage(e) })
              .where(eq(extJobs.id, row.id));
          }
        } else {
          // once:claim 先寫入退避 run_at + attempts+1,執行結果再決定刪除或 dead。
          const claimed = await db()
            .update(extJobs)
            .set({
              runAt: now + RETRY_BACKOFF_MS,
              attempts: row.attempts + 1,
              lastRun: now,
            })
            .where(
              and(
                eq(extJobs.id, row.id),
                eq(extJobs.runAt, row.runAt),
                eq(extJobs.status, "pending"),
              ),
            )
            .returning({ id: extJobs.id });
          if (claimed.length === 0) continue; // 被併發 sweep 搶走

          const handler = rt
            .byId(row.extId)
            ?.jobs?.find((j) => j.id === row.jobId);
          if (!handler) {
            // once 列指向已消失的 handler → 直接標 dead(不再撿起)。
            failed++;
            await db()
              .update(extJobs)
              .set({ status: "dead", lastError: "handler not found" })
              .where(eq(extJobs.id, row.id));
            continue;
          }

          try {
            const services = scopedServices(row.extId, rt.hooks, registry);
            await handler.run(services, parsePayload(row.payload), now);
            processed++;
            await db().delete(extJobs).where(eq(extJobs.id, row.id));
          } catch (e) {
            processed++;
            failed++;
            const attempts = row.attempts + 1;
            await db()
              .update(extJobs)
              .set({
                lastError: errorMessage(e),
                status: attempts >= 3 ? "dead" : "pending",
              })
              .where(eq(extJobs.id, row.id));
          }
        }
      }
    }

    return {
      ok: true,
      processed,
      detail: failed > 0 ? `${failed} failed` : undefined,
    };
  },
};

// ---- license-checkin:見 src/licensing/(open-core 商業授權擴充點)───────────
//
// 這支 job 對 community/open-source build 是徹底的 no-op:src/licensing 的
// community 預設實作(verify.ts)恆回 telemetrySent:false、不發任何請求。
// 只有 build 時磁碟上真的放了 verify.local.ts(gitignored,commercial-only,
// 不隨這個 repo 的 git 歷史散佈)才會有實際行為。掛在 core jobs 只是借用
// 既有的「定期被 lazy sweep / manual 觸發」節奏,節流邏輯在 licensing 模組
// 自己做(見 verify.local.ts 的 CHECKIN_INTERVAL_MS),這裡不重複。
// dynamic import:同 ext-jobs 的 workers pool 理由,且 verify.local.ts 內容
// 不受這個檔案控制(gitignored,commercial 部署方自行維護),靜態 import 會讓
// 測試池暴露在那份檔案未來可能引入的任何相依鏈風險下。
const licenseCheckinJob: CoreJob = {
  id: "license-checkin",
  async run(now: number): Promise<JobRunResult> {
    const { verifier } = await import("@/licensing");
    const result = await verifier.checkIn(now);
    return { ok: result.ok, detail: result.detail };
  },
};

// ---- storage-probe:D1 用量預警(migrations/0015_storage_history.sql)─────────
//
// D1 每個 database 有**硬上限**(Free 500 MB / Workers Paid 10 GB,官方明訂不可
// 調升),而且**沒有 VACUUM** —— 刪除不會把空間還回來(auto_vacuum=0,且所有
// PRAGMA 被 D1 的 authorizer 擋掉),撞牆後只能 export → 建新 DB → import →
// 換 database_id 重部署,有停機。所以預警的價值全部在「早」。
//
// 數字來源是 **D1 每次查詢 meta 都會回的 `size_after`**(官方定義:the size of
// the database after the query is successfully applied)。它是真實的資料庫大小,
// 權威、免費、零設定 —— 不需要 CF API token,也不需要任何統計查詢。
//
// 因此這支 job 的成本是「一句 SELECT 1」。**不要**在這裡加 count(*) /
// sum(length(...)):D1 按 rows read 計費(Free 每天 500 萬列),而一支被 lazy
// sweep 每分鐘觸發的 job 去掃 contents,就是拿計費額度換一個 size_after 已經
// 免費給你的數字。逐表歸因真的需要時臨時查一次即可,不值得常駐。
//
// 走 `getDB()` 拿原生 D1 而不是 drizzle:meta 只在 D1 的回傳物件上,
// drizzle 的 query builder 不轉發它。

/** 兩次探測之間的最小間隔。runDueJobs 每分鐘會被觸發,不節流會塞爆歷史表。 */
/** 位元組的人類可讀化。1024 進位,KB 以上取一位小數。這裡的數字是 D1 回報的
 *  **真實**資料庫大小,不是估算,所以不加 `~` 前綴。 */
function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1024) return `${Math.trunc(n)}B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (abs < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

const STORAGE_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小時

const storageProbeJob: CoreJob = {
  id: "storage-probe",
  async run(now: number): Promise<JobRunResult> {
    // 一句最便宜的查詢,目的不是結果而是它 meta 上的 size_after。
    const probe = await getDB().prepare("SELECT 1").all();
    const sizeAfter = probe.meta?.size_after;
    if (typeof sizeAfter !== "number") {
      // 舊版 workerd / 未來欄位改名都可能走到這。降級成明確的觀測訊息,
      // 不 throw —— 拿不到大小不代表其他 job 該連帶失敗。
      return { ok: true, processed: 0, detail: "size_after 不可用" };
    }

    const [latest] = await db()
      .select({ at: storageHistory.at, sizeAfter: storageHistory.sizeAfter })
      .from(storageHistory)
      .orderBy(desc(storageHistory.at))
      .limit(1);

    if (latest && now - latest.at < STORAGE_PROBE_INTERVAL_MS) {
      return { ok: true, processed: 0, detail: "not_due" };
    }

    await db()
      .insert(storageHistory)
      .values({
        at: now,
        sizeAfter,
        rowsRead: typeof probe.meta?.rows_read === "number" ? probe.meta.rows_read : null,
        note: null,
      })
      .onConflictDoNothing();

    // 成長速率:跟上一筆比。第一次探測沒有基準,只報當下大小。
    const delta = latest ? sizeAfter - latest.sizeAfter : null;
    const trend =
      delta === null
        ? ""
        : ` (${delta >= 0 ? "+" : "-"}${formatBytes(Math.abs(delta))} 自上次)`;

    return { ok: true, processed: 1, detail: `${formatBytes(sizeAfter)}${trend}` };
  },
};

// ---- core-jobs registry(publish-due + ext-jobs + license-checkin + storage-probe)──
const CORE_JOBS: readonly CoreJob[] = [
  publishDueJob,
  extJobsJob,
  licenseCheckinJob,
  storageProbeJob,
];

/**
 * 依序執行所有 core job。**逐任務失敗隔離**:任一任務 throw 不影響其他任務。每支任務
 * 執行後寫 `core.jobs.lastRun.<id>`(epoch ms,經 setSettings)。回傳逐任務報告。
 */
export async function runDueJobs(now: number = Date.now()): Promise<JobRunReport[]> {
  const reports: JobRunReport[] = [];
  const bookkeeping: Record<string, number> = {};
  for (const job of CORE_JOBS) {
    let result: JobRunResult;
    try {
      result = await job.run(now);
    } catch (e) {
      // 失敗隔離:記錄後續跑,絕不中斷其他任務。
      result = { ok: false, detail: errorMessage(e) };
    }
    bookkeeping[lastRunKey(job.id)] = now;
    reports.push({ id: job.id, ...result });
  }
  // 四支 job 的 lastRun 一次 D1 batch 寫完，也只觸發一次 settings cache/hook。
  // bookkeeping 仍是 best-effort：失敗不改變各 job 的真實執行結果。
  try {
    await setSettings(bookkeeping);
  } catch (e) {
    console.error("[jobs] lastRun bookkeeping batch failed", e);
  }
  return reports;
}

/**
 * 本 isolate 已知的最後 sweep 時戳(`core.jobs.lastSweep` 的 per-isolate cache)。
 * Workers isolate 跨請求存活,這層 in-memory 前擋讓「間隔內的 admin render」連那一次
 * settings 讀都省掉——精度不變(cache 的值就是 settings 會回答的值,頂多偏舊;偏舊只會
 * 多做一次無害的 settings 讀,不會漏 sweep)。
 */
let knownLastSweep = 0;

/**
 * Lazy fallback 的節流 sweep。最近兩分鐘有成功 cron heartbeat 時直接 no-op，避免
 * cron 與第一個 admin request 重跑同一批 job。沒有健康 cron 才依 lastSweep 節流。
 * **永不 throw**；競態容忍：先寫 lastSweep 再跑，publish-due 本身冪等。
 */
export async function maybeRunJobs(now: number = Date.now()): Promise<void> {
  try {
    // in-memory 前擋:已知上次 sweep 在間隔內 → 連 settings 讀都不用。
    if (now - knownLastSweep <= SWEEP_INTERVAL_MS) return;
    // 兩次 getSetting 共用同一份 request-cached settings Map，不會多一次全表讀。
    const [lastSweep, lastCronTick] = await Promise.all([
      getSetting<number>(LAST_SWEEP_KEY, 0),
      getSetting<number>(LAST_CRON_TICK_KEY, 0),
    ]);
    if (now - (lastCronTick ?? 0) <= CRON_HEALTH_WINDOW_MS) {
      knownLastSweep = Math.max(knownLastSweep, lastCronTick ?? 0);
      return;
    }
    knownLastSweep = lastSweep ?? 0;
    if (now - knownLastSweep <= SWEEP_INTERVAL_MS) return;
    // 先記帳(縮短併發窗)再執行。
    knownLastSweep = now;
    await setSettings({ [LAST_SWEEP_KEY]: now });
    await runDueJobs(now);
  } catch (e) {
    // 保底:sweep 的任何失敗都不得冒泡到呼叫端(admin layout render)。
    console.error("[jobs] maybeRunJobs sweep failed", e);
  }
}
