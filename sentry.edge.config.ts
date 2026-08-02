import * as Sentry from "@sentry/nextjs";

import { sentryOptions, serverObserveEnv } from "@/lib/observe/sentry-options";

// [core] 不要在客戶站改這個檔。
//
// Edge runtime 的錯誤回報初始化(src/middleware.ts 走這條)。
//
// 設定和 server 端**完全相同**,刻意不做區分 —— 在 OpenNext 底下兩邊跑在同一個
// workerd 上,一個錯誤發生在 middleware 還是 route handler 是實作細節,不該影響它會
// 不會被記錄下來。哪天真的需要分辨,那也該是靠事件上的 tag,不是靠兩份會慢慢漂移的
// 設定。

Sentry.init(sentryOptions(serverObserveEnv()));
