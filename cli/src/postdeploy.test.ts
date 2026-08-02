// scripts/postdeploy.mjs 的行為測試。
//
// 那支腳本不在 cli/src 底下,但它唯一的工作就是包住這支 CLI 的 `secrets` 指令,
// 而它最重要的性質(**永遠 exit 0**)沒有測試就會在某次「順手改一下」裡消失。
// `pnpm test:cli` 是純 Node 環境,這裡跑得起子程序;根的 vitest 是 workers pool,
// 跑不了 —— 所以測試放在 cli/ 這一側。
//
// 做法:把**真正的** scripts/postdeploy.mjs 複製到一棵臨時目錄樹裡,旁邊放一個假的
// cli/dist/cli.js。腳本用 dirname(import.meta.url)/.. 算 root,所以複製過去之後它
// 找到的就是那個假 CLI。全程不碰真的 Cloudflare 帳號,也不碰真的 cli/dist。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_SCRIPT = path.join(REPO_ROOT, "scripts", "postdeploy.mjs");

const MANAGED_SECRETS = ["SECRETS_KEY", "AUTH_PEPPER", "SETUP_TOKEN"];

let root: string;

/**
 * 造一棵假 repo:scripts/postdeploy.mjs(真的那份)+ cli/src/*.ts + cli/dist/cli.js。
 * mtime 明確設定,讓 needsBuild() 判定為「不需要重建」——否則它會去跑 npx tsc。
 */
async function makeTree(fakeCliBody: string): Promise<void> {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "cli", "src"), { recursive: true });
  await mkdir(path.join(root, "cli", "dist"), { recursive: true });
  await copyFile(REAL_SCRIPT, path.join(root, "scripts", "postdeploy.mjs"));

  const src = path.join(root, "cli", "src", "cli.ts");
  const dist = path.join(root, "cli", "dist", "cli.js");
  await writeFile(src, "// placeholder\n", "utf8");
  await writeFile(dist, fakeCliBody, "utf8");

  const old = new Date(Date.now() - 60_000);
  const now = new Date();
  await utimes(src, old, old);
  await utimes(dist, now, now);
}

function runScript(env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "postdeploy.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "szws-postdeploy-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// 🔴 這一組是整支腳本存在的風險所在:部署在它跑起來之前**已經成功了**。
// 任何讓它非零退出的改動,都會把一次成功的部署在終端機上變成紅色的失敗
//(npm/pnpm 會把 postdeploy 的非零退出算成整個 deploy script 失敗)。
describe("scripts/postdeploy.mjs — 絕不把成功的部署變成失敗", () => {
  it("`cms secrets` 因為讀不到 secret list 而失敗 → 仍然 exit 0,並印出手動指令", async () => {
    // 真的 `cms secrets` 在這個情境會 exit 8(EXIT.SETUP_FAILED)。
    await makeTree(
      [
        `console.error("✗ could not read the Worker secret list");`,
        `process.exit(8);`,
        "",
      ].join("\n"),
    );

    const result = runScript();
    expect(result.status).toBe(0);
    // CLI 自己的訊息有透傳(stdio: inherit)。
    expect(result.stderr).toContain("could not read the Worker secret list");
    // 而且腳本自己也把補救指令講了一次,不要求使用者往回捲。
    for (const name of MANAGED_SECRETS) {
      expect(result.stderr).toContain(`wrangler secret put ${name}`);
    }
    expect(result.stderr).toContain("部署本身已經成功");
    expect(result.stderr).toContain("node cli/dist/cli.js secrets");
  });

  it("CLI 直接崩潰(非零 + 例外)→ 仍然 exit 0", async () => {
    await makeTree(`throw new Error("boom");\n`);
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[postdeploy]");
  });

  it("CLI 被訊號殺掉 → 仍然 exit 0", async () => {
    await makeTree(`process.kill(process.pid, "SIGKILL");\n`);
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "CLI 建不起來(dist 缺席且 tsc 失敗)→ 仍然 exit 0",
    async () => {
      await makeTree(`process.exit(0);\n`);
      // dist 移走 → needsBuild() 為真 → 腳本會去跑 `npx tsc -p cli/tsconfig.json`。
      await rm(path.join(root, "cli", "dist", "cli.js"));
      // 用 PATH 遮蔽掉真的 npx,測試才不會去下載/建置任何東西。
      const bin = path.join(root, "fakebin");
      await mkdir(bin, { recursive: true });
      const npx = path.join(bin, "npx");
      await writeFile(npx, "#!/bin/sh\necho 'tsc exploded' >&2\nexit 1\n", "utf8");
      await chmod(npx, 0o755);

      const result = runScript({ PATH: `${bin}:${process.env.PATH ?? ""}` });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("無法建置 CLI");
      for (const name of MANAGED_SECRETS) {
        expect(result.stderr).toContain(`wrangler secret put ${name}`);
      }
    },
  );

  it("一切正常 → exit 0,而且不印任何警告", async () => {
    await makeTree(`console.log("✓ all three managed secrets are already set.");\n`);
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("all three managed secrets");
    expect(result.stderr).not.toContain("[postdeploy]");
  });
});

describe("scripts/postdeploy.mjs — 呼叫的是 `secrets` 指令", () => {
  it("把 argv 傳給 CLI 的是 `secrets`,不是 setup", async () => {
    await makeTree(
      `console.log("ARGV:" + process.argv.slice(2).join(","));\nprocess.exit(0);\n`,
    );
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARGV:secrets");
  });
});
