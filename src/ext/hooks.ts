import { reportError } from "@/lib/observe/report";
import type { HookName, HookHandler } from "./types";

// 03 §2:HookBus。
//
// 兩個 catch 都刻意「接住、記錄、繼續」——一個 extension 的 hook 壞掉不該讓其他
// extension 跟著沉默,更不該讓使用者的請求失敗。這個行為不變。
//
// 但只 console.error 的代價是:那些失敗**沒有人看得到**。Worker 的 log 要有人正好
// 在看 tail 才存在,而 hook 失敗是所有 extension 故障裡最安靜的一種——HTTP 照樣回
// 200,後台照樣顯示存檔成功,只是 webhook 沒送出去、通知信沒寄。所以這裡除了印,
// 還要往錯誤收集端報一次。
//
// reportError 絕不 throw、也刻意不重複 console.error(見 src/lib/observe/report.ts),
// 所以下面兩處的既有行為完全沒有改變,只是多了一個看得到的地方。
export class HookBus {
  private handlers = new Map<HookName, { extId: string; fn: HookHandler }[]>();

  register(extId: string, name: HookName, fn: HookHandler): void {
    const list = this.handlers.get(name) ?? [];
    list.push({ extId, fn });
    this.handlers.set(name, list);
  }

  /** action:依註冊順序執行,錯誤 catch 並 console.error,不中斷其他 handler */
  async doAction(name: HookName, ...args: unknown[]): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) {
      try {
        await h.fn(...args);
      } catch (e) {
        console.error(`[hook:${name}] ext=${h.extId}`, e);
        await reportError(e, { hook: name, ext: h.extId, kind: "action" });
      }
    }
  }

  /** filter:值依序流過所有 handler;handler 拋錯則跳過該 handler */
  async applyFilters<T>(name: HookName, value: T, ...args: unknown[]): Promise<T> {
    let v = value;
    for (const h of this.handlers.get(name) ?? []) {
      try {
        v = await h.fn(v, ...args);
      } catch (e) {
        console.error(`[filter:${name}] ext=${h.extId}`, e);
        await reportError(e, { hook: name, ext: h.extId, kind: "filter" });
      }
    }
    return v;
  }
}
