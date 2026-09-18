// scheduled.ts 動態載入的那一小塊 SDK。
//
// 為什麼不直接 `await import("@sentry/nextjs")`:對整個套件做動態 import,wrangler 的
// 打包就無從判斷用到哪些函式,只能把整包 SDK 的每個匯出都收進 Worker —— 實測比原本的
// 靜態 import 多出約 250KB,每個 isolate 啟動都要多解析一遍。經由這個只轉出三個函式的
// 檔案動態載入,打包照樣能剪掉用不到的部分,載入時機仍然延後到真的要綁 DSN 的時候。
//
// 本檔同樣受 scheduled.ts 檔頭的 import 硬規則約束:只能碰 @sentry/nextjs。
export { captureException, flush, init } from "@sentry/nextjs";
