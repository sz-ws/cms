import type { AgentCodeRun } from "@/ext/agent-code";

// docs/spec-admin-agent.md §4.7:主執行緒 ↔ 沙盒 worker 之間那一則訊息的形狀。
//
// 為什麼是獨立一檔而不是寫在 code-sandbox.ts 裡:worker 那一側若要 import 它,就會
// 把 shell(裡面有 `new Worker(...)`)拉進 worker 自己的打包圖 —— 一個會生出自己的
// 檔案。**這一檔只有 type**,`import type` 在編譯期整個抹除,兩側因此共用同一份定義
// 而不共用任何一行 runtime 程式碼。
//
// 限額由主執行緒**傳進去**,而不是 worker 自己 import @/ext/agent-code:那一檔為了
// zod schema 會拉進 zod,而 worker 是獨立的打包圖 —— import 進去等於在那個 chunk 裡
// 再放一份 zod,只為了讀四個數字。傳進去則順帶保證兩側用的是同一組值。

/** 主執行緒 → worker。一個 worker 只收一次這個訊息,跑完就被 terminate。 */
export interface CodeSandboxRequest {
  code: string;
  /** QuickJS 自己的 interrupt handler 期限(毫秒)。外面另有一道 terminate。 */
  timeoutMs: number;
  memoryLimitBytes: number;
  stackLimitBytes: number;
}

/** worker → 主執行緒。恰好就是 AgentCodeRun —— 收斂與截斷在主執行緒那一側做。 */
export type CodeSandboxResponse = AgentCodeRun;
