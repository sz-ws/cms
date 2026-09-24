import { cache } from "react";
import { getCloudflareContext } from "@opennextjs/cloudflare/cloudflare-context";
import { getDB } from "./cf";
import { computeExtRuntimeStamp } from "@/ext/runtime-stamp";
import {
  COMBINED_STAMP_SQL,
  PUBLIC_PAGE_HEADER,
  PUBLIC_PAGE_VALUE,
  SETTINGS_STAMP_SQL,
  kvTargetFrom,
  publishStamps,
  readStampsFromKv,
  refreshStamps,
  settingsStampFromRow,
  stampsFromCombinedRow,
  type CombinedStampRow,
  type SettingsStampRow,
  type StampSet,
  type StampsRecord,
  type StampsTarget,
} from "./stamps";

export { SETTINGS_STAMP_SQL };

// 每個 request 的版本戳:settings 表一組、extensions/declarative_extensions 一組。
//
// 兩組戳各自決定一份 isolate 級 memo 還新不新鮮(settings.ts 的 readAll、
// ext/loader.ts 的 getExtRuntime),規則不變 —— 每個 request 都對 DB 現況重新指紋,
// 任何寫入在「下一個 request」立即看得見,不是 TTL。
//
// 改變的只有**怎麼問**:以前兩邊各打一次 D1,公開站每一頁固定兩趟來回(layout 拿頁首
// 頁尾要 runtime、root layout 與頁面要 settings)。這裡用一條 scalar subselect 一次
// 拿回兩組,React cache() 讓同一個 request 裡兩邊共用這一趟。SQL 與字串格式在 ./stamps.ts,
// 與 middleware 的 scripts 戳、KV 副本共用同一份。
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
//
// 綁了 CMS_KV 的站(./stamps.ts 的 KV 副本):middleware 認證過的公開頁 GET 先讀 KV 的
// 副本,夠新就直接用 —— 戳對得上 memo 的暖 isolate 整個請求零 D1。副本沒有、壞了、太舊
// 才照舊打 D1,並把算好的寫回 KV。後台、/api、背景工作一律照舊讀 D1。

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

/**
 * D1 那條路(沒有 KV 時唯一的一條)。合併查詢成功才有完整的 record 可以寫回 KV;
 * 退回兩條獨立查詢時沒有 scripts 戳,不寫。
 */
async function fromD1(): Promise<{ stamps: RequestStamps; record: StampsRecord | null }> {
  const at = Date.now();
  let row: CombinedStampRow | null;
  try {
    row = await getDB().prepare(COMBINED_STAMP_SQL).first<CombinedStampRow>();
  } catch {
    // 不在這裡記錯:退回的兩條獨立查詢會各自重現錯誤,由用到該組戳的呼叫端記錄;
    // 另一邊成功就不是錯誤(例如只建了 settings 表的環境)。
    return { stamps: await computeSeparately(), record: null };
  }
  const set = stampsFromCombinedRow(row);
  return { stamps: fromStampSet(set), record: { ...set, at } };
}

/** 這個請求能寫 KV 的東西;沒綁 CMS_KV、或根本不在 request 裡(測試、cron)→ null。 */
function stampsTarget(): StampsTarget | null {
  let context: { env: unknown; ctx?: unknown };
  try {
    context = getCloudflareContext();
  } catch {
    return null;
  }
  const target = kvTargetFrom(context.env, context.ctx);
  return target ? { ...target, d1: getDB() } : null;
}

/**
 * middleware 有沒有把這個請求認證成公開頁 GET(PUBLIC_PAGE_HEADER)。
 *
 * 標頭只可能是 middleware 蓋的:瀏覽器自己帶的,middleware 經過的路徑由它刪,/api 與
 * /_next 由 Worker 入口刪(custom-worker.ts)。所以 route handler 讀得到 headers(),但永遠
 * 讀不到這個標頭 —— /api 一律 D1。
 *
 * headers() 在 request 範圍外(測試、cron、after() 與 unstable_cache 的 callback 裡)會
 * throw 一般的 Error —— 那些都當「不是公開頁」,走 D1,是既有的、保證正確的那條路。但 Next
 * 也用 throw 傳遞自己的控制訊號(動態渲染、postpone、redirect…),那些絕不能在這裡吞掉,
 * 交給 unstable_rethrow 丟回去。(`"use cache"` 是例外:在它裡面呼叫 headers(),就算 catch
 * 了,Next 也會把整頁記成錯誤。本專案沒開 cacheComponents;哪天開了,這裡要先改。)
 *
 * 兩個 import 都是動態的:只有綁了 CMS_KV 的站、在 request 裡才會走到這裡;next/navigation
 * 在 workers 測試池裡靜態載入會炸,而 settings.ts 幾乎每支測試都會拉進來。
 */
async function isPublicPageRequest(): Promise<boolean> {
  let rethrow: (error: unknown) => void = () => {};
  try {
    const [{ headers }, { unstable_rethrow }] = await Promise.all([
      import("next/headers"),
      import("next/navigation"),
    ]);
    rethrow = unstable_rethrow;
    return (await headers()).get(PUBLIC_PAGE_HEADER) === PUBLIC_PAGE_VALUE;
  } catch (e) {
    rethrow(e);
    return false;
  }
}

/**
 * 一個 request 一趟:同時拿 settings 與 extension runtime 的版本戳。公開頁有夠新的 KV
 * 副本時一趟 D1 都不打。除了 Next 自己的控制訊號(見 isPublicPageRequest),永不 throw。
 */
export const getRequestStamps = cache(async (): Promise<RequestStamps> => {
  // 先看 binding(同步、不碰 headers()):沒綁 KV 的站完全不經過下面任何一行 KV 的程式。
  const target = stampsTarget();
  if (!target || !(await isPublicPageRequest())) return (await fromD1()).stamps;

  const cached = await readStampsFromKv(target.kv);
  if (cached.state === "fresh") return fromStampSet(cached.stamps);
  const { stamps, record } = await fromD1();
  if (cached.state === "refresh" && record) refreshStamps(target, record);
  return stamps;
});

/**
 * 寫入之後(invalidateSettingsCache / invalidateExtRuntimeMemo 呼叫):從 D1 重算三組戳、
 * 在回應之後寫進 KV。沒綁 CMS_KV、不在 request 裡 → 什麼都不做。永不 throw。
 *
 * 保證:寫入者所在機房的下一個公開頁請求就看得見;其他機房在 KV 快取過期後(約 60 秒)。
 * 發布失敗會刪掉副本(公開頁回去讀 D1);連刪都失敗,最壞等副本滿 5 分鐘過期。
 */
export function publishRequestStamps(): void {
  try {
    const target = stampsTarget();
    if (target) publishStamps(target);
  } catch (e) {
    console.error("[stamps] could not publish request stamps", e);
  }
}
