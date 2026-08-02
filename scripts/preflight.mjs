// predeploy 的最後一關:跑 `sz-ws-cms preflight --gate`。
//
// 它擋的是「extension 宣告了必填設定,但 wrangler.jsonc 的 vars / Worker secret 裡
// 找不到」。沒有這一關的話,那些站台會 deploy 得很順利,然後在第一個真實請求上
// 才用一個跟原因無關的錯誤炸掉。
//
// 只掛在 predeploy,刻意不掛 prebuild / predev / prepreview / pretest ——
// 那幾支不該被 Cloudflare 登入狀態或線上設定影響。本機開發不需要線上 secret。
//
// 兩種失敗要分清楚:
//
//   設定真的缺       → 非零退出,deploy 停下來。這是這支腳本存在的理由。
//   CLI 跑不起來     → 大聲警告,但**放行**。predeploy 的職責是抓漏掉的設定,
//                      不是變成另一種「因為工具鏈壞了所以 deploy 不出去」的方式。
//                      (真的壞掉的話,後面的 next build 也會自己炸。)
//
// 未登入 Cloudflare 不會擋:preflight 查不到 secret 清單時會降級成「無法驗證」,
// 詳見 cli/src/preflight.ts 的 gateVerdict()。
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "cli", "dist", "cli.js");
const srcDir = join(root, "cli", "src");

/** dist 比 src 舊就重建 —— 不然這道關卡會拿舊的規則去檢查新的 manifest。 */
function needsBuild() {
  if (!existsSync(entry)) return true;
  const builtAt = statSync(entry).mtimeMs;
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .some((f) => statSync(join(srcDir, f)).mtimeMs > builtAt);
}

function skip(reason) {
  console.warn(`[preflight] 略過設定檢查:${reason}`);
  console.warn("[preflight] deploy 會繼續,但沒有人幫你確認 extension 的必填設定。");
  console.warn("[preflight] 手動檢查:pnpm cli:build && node cli/dist/cli.js preflight");
  process.exit(0);
}

if (needsBuild()) {
  try {
    // cli/ 有自己的 tsconfig(純 Node、NodeNext),與 Next 的那份互不相干。
    execFileSync("npx", ["tsc", "-p", "cli/tsconfig.json"], {
      cwd: root,
      stdio: "pipe",
      // Windows 上 npx 是 npx.cmd,不透過 shell 會找不到(同 ensure-dev-env.mjs)。
      shell: process.platform === "win32",
    });
  } catch (e) {
    skip(`無法建置 CLI(${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
  }
}

if (!existsSync(entry)) skip("建置後仍找不到 cli/dist/cli.js");

const result = spawnSync(process.execPath, [entry, "preflight", "--gate"], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) skip(`無法執行 CLI(${result.error.message})`);

// 被訊號殺掉不是「設定有問題」,照樣放行(Ctrl-C 會由外層 shell 處理)。
if (result.signal) skip(`CLI 被訊號中止(${result.signal})`);

process.exit(result.status ?? 0);
