import type { Instrumentation } from "next";

// [core] 不要在客戶站改這個檔 —— src/instrumentation.ts 與 ./report.ts 之間的橋。
//
// ## 為什麼要橋,而不是讓 instrumentation 直接 import report.ts
//
// Next 把 instrumentation 編進自己的一層(webpack layer)。在那一層 import 的每個模組
// 都是**另一份**實例:從那裡 import report.ts,整條 settings / ext loader 相依鏈連同
// Sentry SDK(server bundle 裡最大的一塊)會在 bundle 裡再出現一次 —— 實測 server
// bundle 多出 2.2MB,而 Worker 每個 isolate 啟動都要把整份 bundle 解析一遍,那是
// 冷啟動上實打實的時間。
//
// 所以方向反過來:report.ts 在頁面與 route handler 那幾層被載入時,把「回報一個
// request 錯誤」的函式掛到這裡;instrumentation 只來這裡拿,自己什麼都不 import。
// report.ts 被 settings 的讀取路徑帶進來(getSetting → ext loader → hooks),所以
// 幾乎每個 request 在丟出例外之前就已經掛好。
//
// 還沒掛上的那一刻 —— 這個 isolate 的第一個 request 在碰到任何設定之前就炸掉 ——
// 那一筆會被略過。這是刻意接受的缺口,換掉的是每一次冷啟動的解析時間。
//
// Symbol.for 是整個 isolate 共用的登記表:各層各自的 bridge.ts 實例拿到的是同一把 key。

type RequestErrorForwarder = Instrumentation.onRequestError;

const KEY = Symbol.for("cms.observe.onRequestError");

type Slot = Record<symbol, RequestErrorForwarder | undefined>;

export function setRequestErrorForwarder(fn: RequestErrorForwarder): void {
  (globalThis as unknown as Slot)[KEY] = fn;
}

export function getRequestErrorForwarder(): RequestErrorForwarder | undefined {
  return (globalThis as unknown as Slot)[KEY];
}
