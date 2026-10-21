// 排程「有事才醒」(1.80.0)。
//
// Cloudflare 每分鐘叫一次 cron 的 scheduled handler(extensions/cron/scheduled.ts,約 3 毫秒)。以前它每次都打
// 完整的 tick(/api/callback/cron:tick/cron,經過 Next 與整套插件,約 500 毫秒 CPU),不管有沒有事。現在它先用
// 一句查詢(TICK_DUE_SQL 的那幾欄)看有沒有理由醒,shouldTick 說沒有就結束:
//   - 「該醒了」的記號(heartbeats 的 WAKE_KEY)已經到時間 —— 有新的工作被寫進插件宣告的表(下面);
//   - ext_jobs 裡有到時間的工作(一次性的,或週期性的下一輪);
//   - 有排程發佈的內容到時間;
//   - 上次完整 tick 超過 SAFETY_INTERVAL_MS(保險:漏掉的也會被補做)。
//
// 誰設記號:插件的週期性工作宣告 `wakeOn: ["ext_xxx"]`(ExtJobRegistration),loader 依啟用的插件把這些表交給
// setWakeTables;經過 ledger-kit 交易(appendTransaction)插入這些表時,同一批 statement 裡多一句 WAKE_UPSERT,
// 跟寫入同生共死。不經 ledger-kit 的寫入自己呼叫 requestWake。醒來的那一輪,所有週期性工作都照跑一次
// (src/lib/jobs.ts 的 ext-jobs),跑完把到時間的記號清掉(clearWake)。
//
// 這個檔只用 D1 的原生介面、沒有任何 `@/` 相依:scheduled handler 的 bundle 不能把 Next 拖進去。

/** heartbeats 的 key:最早該醒的時間(epoch ms)。不在任何版本戳裡,寫它不會讓設定快取失效。 */
export const WAKE_KEY = "core.jobs.wakeAt";
/** cron 每次跑完完整 tick 寫的 heartbeat(extensions/cron/provider.ts 的 LAST_TICK_KEY)。 */
export const LAST_TICK_KEY = "ext.cron.lastTick";
/** 沒有事也每隔多久跑一次完整 tick:到期訂單、重寄失敗的信、對帳都靠這一輪。 */
export const SAFETY_INTERVAL_MS = 30 * 60_000;
/** 週期性工作提早多少算到時間(同 jobs.ts 的 RECURRING_DUE_TOLERANCE_MS):cron 不會剛好在那一毫秒醒。 */
export const DUE_TOLERANCE_MS = 15_000;

/** 記號取比較早的那個時間(已經有一個更早的就不動)。 */
export const WAKE_UPSERT_SQL =
  "INSERT INTO heartbeats (key, at) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET at = MIN(heartbeats.at, excluded.at)";

const wakeTables = new Set<string>();

/** loader 每次建 runtime 時呼叫:啟用的插件宣告的 wakeOn 表。 */
export function setWakeTables(tables: Iterable<string>): void {
  wakeTables.clear();
  for (const table of tables) wakeTables.add(table);
}

/** 插入這張表要不要順便設記號(ledger-kit 用)。 */
export function wakesOnInsert(table: string): boolean {
  return wakeTables.has(table);
}

/** 不經 ledger-kit 的寫入自己叫醒排程。at 省略 = 現在(下一分鐘的鬧鐘就會醒)。 */
export async function requestWake(db: D1Database, at: number = Date.now()): Promise<void> {
  await db.prepare(WAKE_UPSERT_SQL).bind(WAKE_KEY, at).run();
}

/** 這一輪(開始於 tickStart)跑完之後:清掉已經到時間的記號;跑的途中新設的(更晚)留著。 */
export async function clearWake(db: D1Database, tickStart: number): Promise<void> {
  await db.prepare("DELETE FROM heartbeats WHERE key = ?1 AND at <= ?2").bind(WAKE_KEY, tickStart).run();
}

/** 記號在不在、到時間了沒(jobs.ts 決定這一輪要不要把週期性工作全部照跑)。 */
export async function wokenAt(db: D1Database, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT at FROM heartbeats WHERE key = ?1").bind(WAKE_KEY).first<{ at: number }>();
  return !!row && row.at <= now;
}

/** scheduled handler 判斷要不要醒的那幾欄(接在它原本那句查詢的 SELECT 裡)。 */
export const TICK_DUE_SQL = `(SELECT at FROM heartbeats WHERE key = '${WAKE_KEY}') AS wake_at,
  (SELECT at FROM heartbeats WHERE key = '${LAST_TICK_KEY}') AS last_tick,
  (SELECT MIN(run_at) FROM ext_jobs WHERE status = 'pending') AS next_job,
  (SELECT MIN(publish_at) FROM contents WHERE status = 'draft' AND publish_at IS NOT NULL) AS next_publish`;

export interface TickDue {
  wake_at: number | null;
  last_tick: number | null;
  next_job: number | null;
  next_publish: number | null;
}

/** 這一分鐘要不要跑完整 tick。從沒跑過、或保險時間到了也要。 */
export function shouldTick(due: TickDue, now: number): boolean {
  if (due.last_tick === null || now - due.last_tick >= SAFETY_INTERVAL_MS) return true;
  if (due.wake_at !== null && due.wake_at <= now) return true;
  if (due.next_job !== null && due.next_job <= now + DUE_TOLERANCE_MS) return true;
  return due.next_publish !== null && due.next_publish <= now;
}
