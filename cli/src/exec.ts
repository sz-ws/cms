// 子程序執行層 —— 唯一會真的動到使用者 Cloudflare 帳號的地方,所以刻意做成可注入。
//
// 為什麼是 injectable:
//   1. 測試不能、也不該真的去建 D1 / R2。整條 setup 流程對著假 Executor 跑,
//      斷言「送出了哪些指令」,比對著真帳號跑更嚴格也更快。
//   2. `--dry-run` 只是換一個 Executor(dryRunExecutor),流程碼一行都不用分岔 ——
//      沒有 `if (dryRun)` 散落各處,就不會有「某條路徑忘了檢查 dry-run」的漏網之魚。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  /** 要餵給子程序 stdin 的內容(例:secret 值,避免出現在 argv / shell history)。 */
  stdin?: string;
}

export type Executor = (
  cmd: string,
  args: readonly string[],
  opts: ExecOptions,
) => Promise<ExecResult>;

/** 已送出的一筆指令(dry-run 與測試用)。 */
export interface RecordedCall {
  cmd: string;
  args: string[];
  /** true 表示這次呼叫有餵 stdin;**不記錄內容**(那是 secret)。 */
  hadStdin: boolean;
}

/**
 * 真的 spawn。wrangler 解析順序:
 *   1. <cwd>/node_modules/.bin/wrangler —— repo pin 的那一版(package.json 釘 4.86.0)
 *   2. 退回 `npx wrangler` —— 沒裝依賴時還有救,但可能觸發下載
 * 直接用 repo 內的 binary 才不會因為全域裝了別版 wrangler 而行為飄移。
 */
export function resolveWranglerCommand(cwd: string): { cmd: string; prefix: string[] } {
  const local = path.join(cwd, "node_modules", ".bin", "wrangler");
  if (existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: "npx", prefix: ["wrangler"] };
}

export const spawnExecutor: Executor = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      // Windows 上 npx 是 npx.cmd,不透過 shell 會找不到(同 scripts/ensure-dev-env.mjs)。
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    // stdin 一律關閉:wrangler 的互動確認(例:d1 migrations apply)在非 TTY 下會自動跳過,
    // 我們已經在自己的 UI 問過一次了,不需要它再問第二次。
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });

/**
 * 只記錄、不執行。`--dry-run` 與單元測試共用。
 * 回傳的 stdout 由 `responses` 決定(測試可以模擬 `d1 list --json` 的輸出);
 * 沒有對應回應時回空字串 + code 0。
 */
export function recordingExecutor(
  responses: (cmd: string, args: readonly string[]) => ExecResult | undefined = () =>
    undefined,
): { executor: Executor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const executor: Executor = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], hadStdin: opts.stdin !== undefined });
    return responses(cmd, args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { executor, calls };
}
