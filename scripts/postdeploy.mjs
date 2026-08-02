// deploy 之後的收尾:跑 `sz-ws-cms secrets`,把三把受管金鑰補到剛上線的 Worker 上。
//
// 為什麼非得在 deploy 之後不可:`wrangler secret put` 需要一個已經存在的 Worker。
// 第一次 `sz-ws-cms setup` 的時候還沒有,所以那三把一定掛不上去。舊流程是叫使用者
// 「deploy 完再跑一次 setup」—— 那個往返很反直覺,而且 setup 的其他步驟第二次跑
// 全是白工。掛在這裡之後,`pnpm run deploy` 一條龍就結束了。
//
// 🔴 這支腳本**永遠 exit 0**。
//
// 部署在它跑起來之前就已經成功了。拿不到 secret list、CLI 建不起來、網路斷掉 ——
// 這些都不能讓一次已經成功的部署在終端機上看起來像失敗(而且 npm/pnpm 會把
// postdeploy 的非零退出當成整個 `deploy` script 失敗)。失敗一律「大聲警告 +
// 印出手動補救指令 + exit 0」。
//
// 只掛 postdeploy,刻意不掛 predeploy / prebuild / predev / prepreview / pretest ——
// 那幾支不該被 Cloudflare 登入狀態或線上資源影響(同 scripts/preflight.mjs)。
//
// ⚠️ package.json 裡一定要寫 `pnpm run deploy`:`deploy` 是 pnpm 的內建指令,
//    `pnpm deploy` 會被它接走(ERR_PNPM_CANNOT_DEPLOY),pre/post hook 都不會跑。
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "cli", "dist", "cli.js");
const srcDir = join(root, "cli", "src");

const MANAGED_SECRETS = ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN"];

/** dist 比 src 舊就重建 —— 不然會拿舊的規則去補新的金鑰清單。 */
function needsBuild() {
  if (!existsSync(entry)) return true;
  const builtAt = statSync(entry).mtimeMs;
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .some((f) => statSync(join(srcDir, f)).mtimeMs > builtAt);
}

/** 唯一的退出路徑之一,而且一定是 0。 */
function giveUp(reason) {
  console.warn("");
  console.warn(`[postdeploy] ⚠ 無法自動確認 Worker 金鑰:${reason}`);
  console.warn("[postdeploy] ⚠ 部署本身已經成功 —— 但下面這三把還沒有人幫你確認:");
  console.warn("");
  console.warn("[postdeploy]   node cli/dist/cli.js secrets      # 建好 CLI 之後重跑這一步");
  console.warn("");
  console.warn("[postdeploy] 或直接手動產生(產生後永遠不能輪換):");
  for (const name of MANAGED_SECRETS) {
    console.warn(`[postdeploy]   openssl rand -base64 32 | pnpm exec wrangler secret put ${name}`);
  }
  console.warn("");
  console.warn("[postdeploy] ⚠ AUTH_PEPPER 必須在「建立第一個管理員」之前就設好。");
  console.warn("[postdeploy] ⚠ 沒有 SETUP_TOKEN 的話 /setup 一律回 503(這是刻意的)。");
  console.warn("[postdeploy] ⚠ 手動設 SETUP_TOKEN 的話請自己留著那個值 —— wrangler 事後讀不回來。");
  console.warn("");
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
    giveUp(`無法建置 CLI(${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
  }
}

if (!existsSync(entry)) giveUp("建置後仍找不到 cli/dist/cli.js");

const result = spawnSync(process.execPath, [entry, "secrets"], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) giveUp(`無法執行 CLI(${result.error.message})`);
if (result.signal) giveUp(`CLI 被訊號中止(${result.signal})`);
if ((result.status ?? 0) !== 0) giveUp(`\`cms secrets\` 以狀態碼 ${result.status} 結束`);

// 成功也一樣 exit 0,只是不印警告。
process.exit(0);
