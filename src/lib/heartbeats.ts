import { inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { heartbeats } from "./schema";

// 排程心跳(migrations/0018_heartbeats.sql):cron tick、lazy sweep、各 core job
// 「最後一次發生」的 epoch ms。
//
// 以前住在 settings 表。settings 的整包快取靠版本戳驗新鮮度(./settings.ts +
// ./request-stamps.ts),心跳每分鐘寫一次,等於每分鐘讓整包設定快取失效一次。
// 這張表刻意**不進任何版本戳**:寫它不會讓任何快取失效。讀它也不走快取 —— 每次
// 都是一句 PK 查詢,節流是呼叫端的事(jobs.ts 的 knownLastSweep)。
//
// 與 settings 的差別:值一律是 epoch ms 整數,不 JSON 編碼、沒有 secret、沒有
// settings:saved hook —— 心跳不是設定,沒有 extension 需要被通知。

/**
 * 讀多個心跳;沒有列的 key 不出現在回傳的 Map 裡。
 *
 * **永不 throw**:讀不到(表還沒建、D1 暫時失誤)一律回空 Map,也就是「從沒發生
 * 過」。每個讀者要的都是同一種降級 —— lazy sweep 照跑(多跑一次無害)、Cron 頁
 * 顯示從未收到 —— 所以集中在這裡做,不讓一個觀測值的讀取失敗弄壞 admin render。
 */
export async function getHeartbeats(
  keys: readonly string[],
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  try {
    const rows = await db()
      .select({ key: heartbeats.key, at: heartbeats.at })
      .from(heartbeats)
      .where(inArray(heartbeats.key, [...keys]));
    return new Map(rows.map((r): [string, number] => [r.key, r.at]));
  } catch (e) {
    console.error("[heartbeats] read failed; treating as never", e);
    return new Map();
  }
}

/** 單一心跳;從沒寫過(或讀不到)回 null。 */
export async function getHeartbeat(key: string): Promise<number | null> {
  return (await getHeartbeats([key])).get(key) ?? null;
}

/**
 * upsert 多個心跳,一句 INSERT … ON CONFLICT 寫完。失敗照常 throw —— 寫入端各自
 * 決定要不要吞(runDueJobs / maybeRunJobs 吞掉只記錯;cron tick 讓它冒泡成 500,
 * scheduled 那一端才會回報「tick 被拒」)。
 */
export async function setHeartbeats(
  entries: Readonly<Record<string, number>>,
): Promise<void> {
  const rows = Object.entries(entries).map(([key, at]) => ({ key, at }));
  if (rows.length === 0) return;
  await db()
    .insert(heartbeats)
    .values(rows)
    .onConflictDoUpdate({
      target: heartbeats.key,
      set: { at: sql`excluded.at` },
    });
}
