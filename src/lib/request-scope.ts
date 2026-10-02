// [core] 一個請求一份的暫存:這個請求裡算過一次、整個請求都能重用的東西放這裡。
//
// 為什麼需要:React 的 cache() 只在 Server Component 的 render 裡有「同一個請求」的範圍。
// Route Handler(/api、callback、排程的 tick)沒有 —— 同一個請求裡每呼叫一次就重算一次。
// 最貴的例子是版本戳(./request-stamps.ts):一輪排程讀幾十次設定,每次都去 D1 問一遍
// 「設定變了沒」。
//
// 範圍由誰開:
//   - Worker 入口(custom-worker.ts)對每個請求開一個 —— 正式站所有請求都有。
//   - 排程的 sweep(./jobs.ts 的 runDueJobs)自己也開:`next dev` 與測試不經過 Worker 入口。
//   已經在範圍裡再開一次,用的是外面那一個(不會蓋掉)。
// 沒人開過範圍(`next dev` 的一般請求、測試)→ requestScope() 回 undefined,呼叫端照舊
// 每次重算,行為與以前一字不差。
//
// 放進來的東西只活到這個請求結束,不跨請求、不跨 isolate —— 這不是快取,不需要失效規則;
// 但**這個請求自己**寫了資料之後,寫入的人要把對應的那一格刪掉(版本戳由
// publishRequestStamps 刪),之後的讀取才會重算。
//
// Next 把 Server Component 與 Route Handler 編成不同的 module 實例,Worker 入口又是另一個
// bundle:三邊要拿到同一個 AsyncLocalStorage,所以掛在 globalThis 的 Symbol.for 上
// (OpenNext 的 cloudflare context 同一招)。格子的 key 同理用 Symbol.for 或字串。
//
// 這個檔只依賴 node:async_hooks:Worker 入口也直接載入它。

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestScope = Map<unknown, unknown>;

const STORAGE_KEY = Symbol.for("cms.request-scope");

function storage(): AsyncLocalStorage<RequestScope> {
  const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>;
  return (holder[STORAGE_KEY] ??= new AsyncLocalStorage<RequestScope>());
}

/** 在一個請求範圍裡跑 fn。已經在範圍裡就直接跑(沿用外面那一個)。 */
export function runInRequestScope<T>(fn: () => T): T {
  const scopes = storage();
  return scopes.getStore() ? fn() : scopes.run(new Map(), fn);
}

/** 目前這個請求的暫存;不在任何範圍裡回 undefined。 */
export function requestScope(): RequestScope | undefined {
  return storage().getStore();
}
