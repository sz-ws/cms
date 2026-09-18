import { cache } from "react";
import { getDB } from "./cf";
import { computeExtRuntimeStamp } from "@/ext/runtime-stamp";

// 每個 request 的版本戳:settings 表一組、extensions/declarative_extensions 一組。
//
// 兩組戳各自決定一份 isolate 級 memo 還新不新鮮(settings.ts 的 readAll、
// ext/loader.ts 的 getExtRuntime),規則不變 —— 每個 request 都對 DB 現況重新指紋,
// 任何寫入在「下一個 request」立即看得見,不是 TTL。
//
// 改變的只有**怎麼問**:以前兩邊各打一次 D1,公開站每一頁固定兩趟來回(layout 拿頁首
// 頁尾要 runtime、root layout 與頁面要 settings)。這裡用一條 scalar subselect 一次
// 拿回兩組,React cache() 讓同一個 request 裡兩邊共用這一趟。
//
// 合併查詢失敗時(典型:其中一張表還不存在 —— 測試的最小 DDL、剛建好還沒跑完
// migration 的庫),退回兩條各自獨立的查詢,讓「settings 表好好的」這一邊照樣有 memo,
// 不因為另一張表而一起失效。仍然失敗的那一組回 ok:false 帶原錯誤,由**用到它的那一邊**
// 記錯並照舊走完整讀取、不寫 memo —— 只讀 settings 的 request 不該冒出 loader 的錯誤。
//
// 同 request 內的新鮮度:兩組戳在這個 request 第一次用到任一邊時一起算好。這個 request
// 之後若寫入,寫入路徑本來就會主動清 memo(invalidateSettingsCache /
// invalidateExtRuntimeMemo)→ 呼叫端退回完整讀取,讀到的是新值;route handler 沒有
// React cache 的 request 範圍,每次呼叫都會重算。render 期間唯一的寫入是 admin layout
// 的 maybeRunJobs:它的心跳寫進 heartbeats 表(migrations/0018),**刻意不在任何一組
// 戳裡** —— 每分鐘一次的心跳若推動 settings 的戳,整包設定快取就每分鐘失效一次。

export const SETTINGS_STAMP_SQL =
  "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m FROM settings";

const COMBINED_STAMP_SQL = `SELECT
  (SELECT COUNT(*) FROM settings) AS sN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM settings) AS sM,
  (SELECT COUNT(*) FROM extensions) AS exN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM extensions) AS exM,
  (SELECT COALESCE(SUM(enabled), 0) FROM extensions) AS exE,
  (SELECT COUNT(*) FROM declarative_extensions) AS dxN,
  (SELECT COALESCE(MAX(updated_at), 0) FROM declarative_extensions) AS dxM,
  (SELECT COALESCE(SUM(enabled), 0) FROM declarative_extensions) AS dxE`;

interface CombinedStampRow {
  sN: number;
  sM: number;
  exN: number;
  exM: number;
  exE: number;
  dxN: number;
  dxM: number;
  dxE: number;
}

export type StampResult = { ok: true; stamp: string } | { ok: false; error: unknown };

export interface RequestStamps {
  /** settings 表指紋;ok:false = 查不到,呼叫端不可信任 memo。 */
  settings: StampResult;
  /** extensions + declarative_extensions 指紋;ok:false 同上。 */
  extensions: StampResult;
}

function toResult(settled: PromiseSettledResult<string>): StampResult {
  return settled.status === "fulfilled"
    ? { ok: true, stamp: settled.value }
    : { ok: false, error: settled.reason };
}

/** settings 表單獨指紋。格式必須與合併查詢一致(`n:m`),memo 才能跨兩條路比對。 */
export async function computeSettingsStamp(): Promise<string> {
  const row = await getDB()
    .prepare(SETTINGS_STAMP_SQL)
    .first<{ n: number; m: number }>();
  if (!row) return "0:0";
  return `${row.n}:${row.m}`;
}

async function computeSeparately(): Promise<RequestStamps> {
  const [settings, extensions] = await Promise.allSettled([
    computeSettingsStamp(),
    computeExtRuntimeStamp(),
  ]);
  return { settings: toResult(settings), extensions: toResult(extensions) };
}

/** 一個 request 一趟 D1:同時拿 settings 與 extension runtime 的版本戳。永不 throw。 */
export const getRequestStamps = cache(async (): Promise<RequestStamps> => {
  let row: CombinedStampRow | null;
  try {
    row = await getDB().prepare(COMBINED_STAMP_SQL).first<CombinedStampRow>();
  } catch {
    // 不在這裡記錯:退回的兩條獨立查詢會各自重現錯誤,由用到該組戳的呼叫端記錄;
    // 另一邊成功就不是錯誤(例如只建了 settings 表的環境)。
    return computeSeparately();
  }
  if (!row) {
    return {
      settings: { ok: true, stamp: "0:0" },
      extensions: { ok: true, stamp: "0:0:0|0:0:0" },
    };
  }
  return {
    settings: { ok: true, stamp: `${row.sN}:${row.sM}` },
    extensions: {
      ok: true,
      stamp: `${row.exN}:${row.exM}:${row.exE}|${row.dxN}:${row.dxM}:${row.dxE}`,
    },
  };
});
