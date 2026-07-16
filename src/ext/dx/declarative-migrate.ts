import { sql, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { extMigrations } from "@/lib/schema";

// declarative extension migrations —— 與 src/ext/manager.ts runMigrations
// (code extension)對稱,差別:
//
//   - 輸入是 `string[]`,無外部 id,用 array index(0-based,4 位 zero-pad)。
//   - 不用 db.batch 包裹 SQL(每條都是 IF NOT EXISTS CREATE,D1 對冪等 CREATE 已
//     保證單語句原子);改用 prepare+run() 逐條,簡潔、可讀。
//   - 即使兩 request 同時跑 CREATE table(無 batch 包裹),第二個會拿到
//     SQLITE_ERROR "table already exists" —— 視為已套用吞掉,ext_migrations INSERT
//     不寫。後續 request 自然無重試。
//   - INSERT 拆開執行而非包進 batch:即使中途失敗,下次重試會從該 idx 重新跑 —
//     中斷點的 SQL 沒被「標記已套用」(冪等粒度更細)。
//
// 冪等雙保險:① 查 ext_migrations 該 key 已存在則 skip;② SQL 自身 CREATE …
// IF NOT EXISTS。呼叫端:install route(主要路徑,失敗回 500 不上線)+
// loader 兜底(seed/直寫 DB 的 row;module 級 memo 每 isolate 每 extId 一次)。

const PAD = 4;
const pad = (i: number) => String(i).padStart(PAD, "0");

// drizzle 把 D1 錯誤包成 `Failed query: …`,真正的 "already exists" 在 cause 鏈
// 深處 —— 只看 e.message 永遠比不到。攤平整條 cause 鏈再比對。
function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

/** 構造 `ext_migrations.id` 的 key —— `<extId>:<4位 idx>`。補零為排序友善。 */
export function migrationKey(extId: string, idx: number): string {
  return `${extId}:${pad(idx)}`;
}

/**
 * 對 declarative extension 跑其 manifest 上的 migrations。冪等;每條 statement
 * 必須是 CREATE … IF NOT EXISTS(zod contract 已把關)。無 statements 時 early return。
 *
 * 拋錯條件:
 *   - 任一 statement 含 `;`(被 IF NOT EXISTS 之外的錯誤訊息包住) ——
 *     `await db().run(sql.raw(...))` 會丟 D1 runtime error 給呼叫端。
 *   - 其他非「already exists」的 SQL 錯誤 —— 直接 throw,呼叫端決定 retry / log。
 *
 * 注意:本 helper 內部已捕獲「table already exists」並靜默跳過,**不重寫記錄**
 * —— 首次 CREATE 成功後又因 race 丟同樣 SQL 的 request 視為無副作用。
 */
export async function runDeclarativeMigrations(
  extId: string,
  sqls: readonly string[],
): Promise<void> {
  if (sqls.length === 0) return;

  const applied = await db()
    .select({ id: extMigrations.id })
    .from(extMigrations)
    .where(eq(extMigrations.extId, extId));
  const appliedIds = new Set(applied.map((r) => r.id));

  const now = Date.now();
  for (let i = 0; i < sqls.length; i++) {
    const key = migrationKey(extId, i);
    if (appliedIds.has(key)) continue;

    try {
      await db().run(sql.raw(sqls[i]));
    } catch (e) {
      // Race:另一個 request 已 CREATE 此表 —— 已冪等,跳過。
      if (/already exists/i.test(errorText(e))) continue;
      throw e;
    }
    await db().insert(extMigrations).values({
      id: key,
      extId,
      appliedAt: now,
    });
  }
}
