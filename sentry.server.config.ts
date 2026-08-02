import * as Sentry from "@sentry/nextjs";

import { sentryOptions, serverObserveEnv } from "@/lib/observe/sentry-options";

// [core] 不要在客戶站改這個檔。
//
// Worker 這一側(server runtime)的錯誤回報初始化。檔名是 Next.js 的約定,由
// instrumentation.ts 的 register() 動態 import —— 不要改名,也不要在別處 import 它。
//
// 這是最重要的一半。前端的錯誤使用者自己看得到(頁面壞了他會知道),但 Worker 裡的
// 錯誤沒有任何人看得到:排程沒跑、webhook 送不出去、某個 extension 的 hook 一直在
// 丟錯 —— 站台從外面看起來完全正常。
//
// DSN 只從環境變數來:module load 的時候還沒有 request,讀不到 D1,所以後台設定的
// 那顆 DSN 在這一刻不存在。它會在第一個真的要回報東西的 request 補綁上去
// (見 src/lib/observe/report.ts 的 ensureReporting)。兩條路的差別與取捨都寫在那裡。

Sentry.init(sentryOptions(serverObserveEnv()));
