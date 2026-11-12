import { revalidatePath } from "next/cache";
import { reportError } from "@/lib/observe/report";

// [core] 2.0 頁面快取:公開頁算一次就整頁存起來(OpenNext 的 R2 增量快取 + D1 tag 快取),
// 之後由 OpenNext 的快取攔截直接回應,不跑 Next server。內容變了,就靠這一個函式讓它們重算。
//
// 只有一種失效:整個公開站。revalidatePath("/", "layout") 寫的是根 layout 的隱含 tag
// (`_N_T_/layout`),每一個頁面的快取項都帶著它,所以這一個呼叫永遠是對的 —— 不必維護
// 「哪一頁讀了哪些資料」的對照表,漏了一頁也不可能。代價是寫入之後每一頁在下一次造訪時
// 各重算一次;CMS 的寫入頻率下這很便宜。
//
// 不帶 profile:Next 對沒有 profile 的 revalidatePath 是「立刻過期」,下一個請求直接重算,
// 不會先回舊頁再背景更新 —— 後者要 queue,這個專案不用 queue(見 open-next.config.ts)。
//
// 誰呼叫:寫入的底層依 visitorFacing 記號決定(src/lib/visitor-facing.ts);少數寫入明確呼叫(escape hatch)。
//
// 規則:寫入 commit 之後、在同一個請求裡(route handler、server action、cron 跑的 job)呼叫。
// 在請求之外(waitUntil、after()、Worker 的 scheduled)Next 會丟 "static generation store
// missing";那種情況這裡記錄並回報,寫入本身不受影響,頁面會舊到下一次任何失效或下一次部署。

/**
 * 告訴 CMS:訪客看得到的東西變了。每一個存起來的公開頁都在下一次造訪時重算。
 * reason 只用在 log 與錯誤回報(例如 "content:blog.post"),讓「頁面是舊的」查得到是誰沒通知。
 * 永不 throw。
 */
export function publicContentChanged(reason: string): void {
  try {
    revalidatePath("/", "layout");
  } catch (error) {
    console.error(`[public-cache] could not invalidate public pages reason=${reason}`, error);
    void reportError(error, { kind: "public-cache", reason });
  }
}
