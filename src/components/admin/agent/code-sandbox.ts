import {
  CODE_MEMORY_LIMIT_BYTES,
  CODE_STACK_LIMIT_BYTES,
  CODE_TIMEOUT_MS,
} from "@/ext/agent-code";
import type { AgentCodeRun } from "@/ext/agent-code";
import type { CodeSandboxRequest } from "./code-sandbox-protocol";

// docs/spec-admin-agent.md §4.7:沙盒的**薄殼**。
//
// 這一檔刻意只做四件事:開一個 worker、送一則訊息、等一個回應或逾時、無論如何都
// terminate。所有「什麼算合法、結果怎麼收斂、超過上限怎麼截」都不在這裡 —— 那些
// 住 @/ext/agent-code(純函式、有測試)。
//
// 為什麼要這麼薄:**這一層是整個功能唯一測不到的地方**。測試跑在 workerd,沒有
// Web Worker、沒有 DOM、沒有 WebAssembly 的瀏覽器載入路徑。所以這裡的規則是「少到
// 用眼睛看得完」,而不是「寫得漂亮」。任何有分支、有取捨的邏輯都應該被搬到隔壁那
// 個測得到的檔案去。
//
// ── 逾時有兩道,順序是刻意的 ────────────────────────────────────────────────
//   1. QuickJS 的 interrupt handler(在 worker 裡,期限 CODE_TIMEOUT_MS)——
//      它能讓 VM 抛出一個乾淨的錯誤,而那個錯誤帶著「已經 log 了什麼」回來。
//   2. 這裡的計時器 + worker.terminate()(期限再寬一點)—— 專門對付第 1 道進不去
//      的情況:一個單一的巨量配置、或 WASM 自己卡住。terminate 是**唯一**保證停得
//      下來的手段,所以它必須存在,而且必須在最外面。
//
// 寬限值不是隨便加的:第 1 道觸發之後,worker 還要把錯誤序列化、postMessage、
// 主執行緒再解析。沒有寬限的話,兩道會在同一瞬間互相搶 —— 而搶輸的那次,admin
// 看到的是「terminated」而不是「你的迴圈跑太久了」。

/** 第 2 道逾時的寬限(毫秒)。見檔頭。 */
const TERMINATE_GRACE_MS = 750;

/**
 * 跑一段模型寫的 JS,回一份原始回報。**永不 throw、永遠回傳**。
 *
 * 為什麼永不 throw:呼叫端拿到的東西一定要能變成一則 tool_result —— 懸空的
 * tool_use 會讓下一次 /chat 被上游整份拒收(transcript.ts 檔頭)。一個會 throw 的
 * 沙盒等於在那條鐵律上開一個只有在瀏覽器裡才看得到的洞。
 *
 * `signal` 中止時(admin 關掉卡片、面板 unmount)一樣回傳一個結果,只是呼叫端通常
 * 會忽略它 —— 那條路自己補了 tool_result。
 */
export function runCodeInSandbox(
  code: string,
  signal?: AbortSignal,
): Promise<AgentCodeRun> {
  return new Promise<AgentCodeRun>((resolve) => {
    let worker: Worker;
    try {
      // `new URL(..., import.meta.url)` 是打包器認得的 worker 宣告形式:它會把
      // worker 拆成自己的 chunk,而那個 chunk **只**被這一行參照到 —— 所以它連同
      // 它拉進來的 QuickJS 都不可能出現在全站 bundle 裡。
      worker = new Worker(new URL("./code-sandbox.worker.ts", import.meta.url));
    } catch (e) {
      resolve({
        ok: false,
        logs: [],
        error: `the sandbox could not start in the administrator's browser (${e instanceof Error ? e.message : "unknown error"}).`,
      });
      return;
    }

    let settled = false;
    const finish = (run: AgentCodeRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // 一律 terminate:跑完的 worker 沒有用處,而沒跑完的那一個正是我們要殺的。
      // 「每次執行一個乾淨的 runtime」也由這一行保證。
      worker.terminate();
      resolve(run);
    };

    const onAbort = (): void => {
      finish({ ok: false, logs: [], error: "cancelled" });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        logs: [],
        error: `execution was stopped after ${CODE_TIMEOUT_MS} ms. The snippet ran too long — most likely a loop that never ends or a data set too large to process here.`,
      });
    }, CODE_TIMEOUT_MS + TERMINATE_GRACE_MS);

    worker.addEventListener("message", (event: MessageEvent) => {
      finish(event.data as AgentCodeRun);
    });
    // worker 自己載不起來(chunk 404、CSP 擋掉)。這條路不回報的話,admin 會盯著
    // 一張「執行中」的卡片看滿 5 秒才拿到一個逾時訊息。
    worker.addEventListener("error", (event: ErrorEvent) => {
      finish({
        ok: false,
        logs: [],
        error: `the sandbox failed to load (${event.message || "worker error"}).`,
      });
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    const request: CodeSandboxRequest = {
      code,
      timeoutMs: CODE_TIMEOUT_MS,
      memoryLimitBytes: CODE_MEMORY_LIMIT_BYTES,
      stackLimitBytes: CODE_STACK_LIMIT_BYTES,
    };
    worker.postMessage(request);
  });
}
