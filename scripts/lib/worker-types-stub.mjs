// OpenNext 的 worker.js 沒有附型別。Worker 入口(custom-worker.ts、worker/split-entry.ts)
// import 它時,tsc 讀的是旁邊這份只有型別的宣告:scripts/ensure-dev-env.mjs 在還沒 build 時放
// 佔位,scripts/split-server-chunks.mjs 在 .open-next/split/ 旁邊也寫一份。
export const WORKER_TYPES_STUB = [
  "// 由 scripts/ 產生的型別宣告(見 scripts/lib/worker-types-stub.mjs)。",
  "declare const handler: {",
  "  fetch(",
  "    request: Request,",
  "    env: CloudflareEnv,",
  "    ctx: ExecutionContext,",
  "  ): Response | Promise<Response>;",
  "};",
  "export default handler;",
  "",
].join("\n");
