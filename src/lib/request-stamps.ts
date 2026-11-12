import { cache } from "react";
import { getDB } from "./cf";
import { computeExtRuntimeStamp } from "@/ext/runtime-stamp";
import { coldStampsRecord } from "./cold-snapshot";
import { requestScope } from "./request-scope";
import {
  COMBINED_STAMP_SQL,
  SETTINGS_STAMP_SQL,
  settingsStampFromRow,
  stampsFromCombinedRow,
  type CombinedStampRow,
  type SettingsStampRow,
  type StampSet,
} from "./stamps";

export { SETTINGS_STAMP_SQL };

// 每個 request 的版本戳:settings 表一組、extensions/declarative_extensions 一組。
//
// 兩組戳各自決定一份 isolate 級 memo 還新不新鮮(settings.ts 的 readAll、
// ext/loader.ts 的 getExtRuntime),規則不變 —— 每個 request 都對 DB 現況重新指紋,
// 任何寫入在「下一個 request」立即看得見,不是 TTL。
//
// 改變的只有**怎麼問**:以前兩邊各打一次 D1,每一頁固定兩趟來回(layout 拿頁首頁尾要
// runtime、root layout 與頁面要 settings)。這裡用一條查詢一次拿回兩組,React cache() 讓
// 同一個 request 裡兩邊共用這一趟。SQL 與字串格式在 ./stamps.ts。
//
// 合併查詢失敗時(典型:其中一張表還不存在 —— 測試的最小 DDL、剛建好還沒跑完
// migration 的庫),退回兩條各自獨立的查詢,讓「settings 表好好的」這一邊照樣有 memo,
// 不因為另一張表而一起失效。仍然失敗的那一組回 ok:false 帶原錯誤,由**用到它的那一邊**
// 記錯並照舊走完整讀取、不寫 memo —— 只讀 settings 的 request 不該冒出 loader 的錯誤。
//
// 同 request 內的新鮮度:兩組戳在這個 request 第一次用到任一邊時一起算好。這個 request
// 之後若寫入,寫入路徑本來就會主動清 memo(invalidateSettingsCache /
// invalidateExtRuntimeMemo)→ 呼叫端退回完整讀取,讀到的是新值;route handler 沒有
// React cache 的 request 範圍,改用請求範圍(./request-scope.ts)記住這一趟,寫入時同樣
// 作廢(見 getRequestStamps / forgetRequestStamps)。render 期間唯一的寫入是 admin layout
// 的 maybeRunJobs:它的心跳寫進 heartbeats 表(migrations/0018),**刻意不在任何一組
// 戳裡** —— 每分鐘一次的心跳若推動 settings 的戳,整包設定快取就每分鐘失效一次。
//
// 冷的 isolate(./cold-snapshot.ts):這個 module graph 第一次要去 D1 算戳時,戳與設定、
// extension runtime 的列放在同一個 batch 裡讀 —— 算戳那一趟順便把兩份 memo 要的資料帶回來。

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

function fromStampSet(stamps: StampSet): RequestStamps {
  return {
    settings: { ok: true, stamp: stamps.settings },
    extensions: { ok: true, stamp: stamps.extensions },
  };
}

/** settings 表單獨指紋。格式必須與合併查詢一致(`n:m`),memo 才能跨兩條路比對。 */
export async function computeSettingsStamp(): Promise<string> {
  const row = await getDB().prepare(SETTINGS_STAMP_SQL).first<SettingsStampRow>();
  return settingsStampFromRow(row);
}

async function computeSeparately(): Promise<RequestStamps> {
  const [settings, extensions] = await Promise.allSettled([
    computeSettingsStamp(),
    computeExtRuntimeStamp(),
  ]);
  return { settings: toResult(settings), extensions: toResult(extensions) };
}

async function computeRequestStamps(): Promise<RequestStamps> {
  // 這個 graph 的第一趟:戳與兩份 memo 的資料一起讀。
  const cold = await coldStampsRecord();
  if (cold) return fromStampSet(cold);
  try {
    const row = await getDB().prepare(COMBINED_STAMP_SQL).first<CombinedStampRow>();
    return fromStampSet(stampsFromCombinedRow(row));
  } catch {
    // 不在這裡記錯:退回的兩條獨立查詢會各自重現錯誤,由用到該組戳的呼叫端記錄;
    // 另一邊成功就不是錯誤(例如只建了 settings 表的環境)。
    return computeSeparately();
  }
}

/** 這個請求算好的戳放在請求範圍(./request-scope.ts)的哪一格。三個 module 圖共用。 */
const SCOPE_SLOT = Symbol.for("cms.request-stamps");

/**
 * 一個 request 一趟:同時拿 settings 與 extension runtime 的版本戳。永不 throw。
 *
 * 「一個 request」靠兩層:Server Component 的 render 有 React cache();Route Handler 沒有,
 * 靠請求範圍 —— 同一個請求(或同一輪排程)裡第二次以後直接拿第一次算好的。這個請求自己
 * 寫了東西之後 forgetRequestStamps 會把那一格刪掉,下一次讀就重算。不在任何範圍裡
 * (`next dev`、測試)→ 每次呼叫都重算,與以前相同。
 */
export const getRequestStamps = cache((): Promise<RequestStamps> => {
  const scope = requestScope();
  if (!scope) return computeRequestStamps();
  const known = scope.get(SCOPE_SLOT) as Promise<RequestStamps> | undefined;
  if (known) return known;
  const computing = computeRequestStamps();
  scope.set(SCOPE_SLOT, computing);
  // 只記「兩組都算出來」的那一次。有一組查不到(D1 一時失敗、表還沒建)的,不留:下一個呼叫自己再問一次,與沒有範圍時相同。
  const forget = () => {
    if (scope.get(SCOPE_SLOT) === computing) scope.delete(SCOPE_SLOT);
  };
  computing.then((stamps) => {
    if (!stamps.settings.ok || !stamps.extensions.ok) forget();
  }, forget);
  return computing;
});

/**
 * 寫入之後(invalidateSettingsCache / invalidateExtRuntimeMemo 呼叫):這個請求先前算好的戳
 * 作廢(請求範圍裡的那一格),之後的讀取會重算。不在範圍裡就什麼都不做。永不 throw。
 */
export function forgetRequestStamps(): void {
  requestScope()?.delete(SCOPE_SLOT);
}
