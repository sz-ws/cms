import { revalidateTag } from "next/cache";
import { contentTag, extTag, storageIndexTag } from "./cache-tags";

// core-v2:content mutation 後精準失效 public content cache(見 content-cache.ts)。
//
// 硬規則:revalidateTag 在非 request scope(build、背景任務、某些 OpenNext 情境)會
// throw —— 這裡一律 try/catch + console.error 降級。cache 失效失敗「絕不可」讓底層的
// create/update/delete 或 install/enable/disable 連帶失敗;最壞情況只是 cache 未即時
// 失效(下一次 revalidate 或 TTL 收斂),資料正確性不受影響。
//
// 此模組刻意不 import runtime / content-provider,只依賴 next/cache + 純 cache-tags,
// 以免 content-provider → cache-invalidate → runtime → content-provider 的循環 import。
//
// next 16 的 revalidateTag(tag, profile) 需要第二個 cache-life profile 參數;單一參數
// 已 deprecated。這裡在 route handler / provider(非 Server Action)情境呼叫,故不能用
// 只限 Server Action 的 updateTag()。
//
// 2.0:一律 { expire: 0 }(立刻過期),不用 "max"。頁面渲染時讀過的 unstable_cache 會把
// 它的 tag 抄到存起來的整頁上;"max" 是 stale-while-revalidate,OpenNext 會把那些頁面當成
// 「舊的、背景重算」,背景重算要 queue,這個專案沒有 queue —— 頁面就一直卡在舊版
// (2.0 Phase 1 實測)。公開頁的失效走 @/lib/public-cache 的 publicContentChanged。
const REVALIDATE_PROFILE = { expire: 0 };

/** 精準失效單一 content type(create/update/delete 後呼叫)。type = "<extId>.<typeName>"。 */
export function revalidateContent(type: string): void {
  try {
    revalidateTag(contentTag(type), REVALIDATE_PROFILE);
  } catch (err) {
    console.error(`[dx:cache] revalidateContent failed type=${type}`, err);
  }
}

/** 整批失效某 extension 的 content(install / enable / disable 後呼叫)。 */
export function revalidateExt(extId: string): void {
  try {
    revalidateTag(extTag(extId), REVALIDATE_PROFILE);
  } catch (err) {
    console.error(`[dx:cache] revalidateExt failed ext=${extId}`, err);
  }
}

/** R2 object 數量/總容量 snapshot：upload/delete 後整份失效。 */
export function revalidateStorageIndex(): void {
  try {
    revalidateTag(storageIndexTag(), REVALIDATE_PROFILE);
  } catch (err) {
    console.error("[storage:cache] revalidateStorageIndex failed", err);
  }
}
