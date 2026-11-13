// `pnpm run deploy` → 這個 repo 裡的 CLI(cli/)的 `cms deploy`,以及任何其他指令:
//   node scripts/cms.mjs <command> [flags]
//
// CLI 在這個 repo 裡是原始碼(cli/src),dist 不進版控。dist 比原始碼舊或不存在就先用
// cli/tsconfig.json 建一次(純 tsc,幾秒),再把指令與結束代碼原樣交給 CLI。
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "cli", "dist", "cli.js");
const srcDir = join(root, "cli", "src");

function needsBuild() {
  if (!existsSync(entry)) return true;
  const builtAt = statSync(entry).mtimeMs;
  return readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .some((f) => statSync(join(srcDir, f)).mtimeMs > builtAt);
}

if (needsBuild()) {
  execFileSync("npx", ["tsc", "-p", "cli/tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
    // Windows 上 npx 是 npx.cmd,不透過 shell 會找不到(同 ensure-dev-env.mjs)。
    shell: process.platform === "win32",
  });
}

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { cwd: process.cwd(), stdio: "inherit" });
if (result.error) {
  console.error(`could not run the CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : 1));
