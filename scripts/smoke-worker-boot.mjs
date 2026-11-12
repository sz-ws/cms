#!/usr/bin/env node
// 開機檢查:用 `wrangler dev` 把建置好的 Worker 跑起來,打幾個網址,確認它真的能回應。
//
// 為什麼需要:拆分(scripts/split-server-chunks.mjs)綁在 OpenNext 與 esbuild 的輸出形狀上,
// 而「打包得過」不等於「跑得起來」—— 模組少了一個、接橋少了一個名字,wrangler 照樣打包、
// 照樣上傳,要到第一個需要 Next server 的請求才 500。這支在部署前把那種情況擋下來。
// 兩個入口都適用:它跑的是 wrangler 設定裡的 `main`。
//
// 不碰開發者自己的資料:本機 D1 套 migrations 到一個用完即刪的暫存資料夾(--persist-to),
// 遠端 binding 全部關掉(--local,不需要登入)。不管成功失敗,最後都停掉 wrangler 與它的
// workerd 子程序。
//
// 用法:node scripts/smoke-worker-boot.mjs [--config <wrangler 設定檔>]
//   先跑過 opennextjs-cloudflare build(選用拆分入口的站,再跑 scripts/split-server-chunks.mjs)。
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { unstable_readConfig } from "wrangler";
import { fingerprintProblem } from "./split-server/fingerprint.mjs";

const root = path.resolve(import.meta.dirname, "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;

// 每一項:路徑、預期狀態碼、(可選)預期轉址到的路徑。不跟隨轉址。
// - `/`:需要 Next server 的頁面
// - `/admin`:只跑 middleware(沒登入 → 307 到 /login)
// - `/robots.txt`:路由處理器
// - `/api/search`:API 路由;沒登入回 401,而且不會碰到後台資料
// - `/login`:另一個存起來的頁面(後台那一組的 layout 與元件,跟公開頁是不同的模組)
// - `/shop/cart`:插件的公開頁(shop 在下面的 SEED 裡啟用;插件元件是另一批模組)
// - `/api/ext/shop/checkout-visitor`:插件 API 的分派路由(公開;沒登入回 signedIn: false)
// - `/__scheduled`:`scheduled` handler 存在而且跑得完(wrangler dev --test-scheduled)
// 拆分入口每個路由的模組要到第一次被請求才編譯,所以每一項盡量走不同的一組模組。
const CHECKS = [
  { path: "/", status: 200 },
  { path: "/admin", status: 307, location: "/login" },
  { path: "/robots.txt", status: 200 },
  { path: "/api/search?q=smoke", status: 401 },
  { path: "/login", status: 200 },
  { path: "/shop/cart", status: 200 },
  { path: "/api/ext/shop/checkout-visitor", status: 200 },
  { path: "/__scheduled?cron=*+*+*+*+*", status: 200 },
];

// 本機 D1 套完 migrations 之後先啟用 shop(編進來的插件,coreApi ^2.0.0),上面才有插件的頁面與 API 可打。
const SEED = "INSERT INTO extensions (id, enabled, version, installed_at, updated_at) VALUES ('shop', 1, '0.0.0', 0, 0)";

function parseArgs(argv) {
  const args = { config: path.join(root, "wrangler.jsonc") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) args.config = path.resolve(argv[(i += 1)]);
    else throw new Error(`不認得的參數 ${argv[i]}。用法:node scripts/smoke-worker-boot.mjs [--config <path>]`);
  }
  return args;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function wranglerEnv() {
  // CI=true:wrangler 不跳互動確認(migrations apply 會問)。
  return { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
}

function applyMigrations(config, persistTo) {
  execFileSync(
    process.execPath,
    [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", persistTo],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: wranglerEnv() },
  );
  execFileSync(
    process.execPath,
    [wrangler, "d1", "execute", "DB", "--local", "--config", config, "--persist-to", persistTo, "--command", SEED],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: wranglerEnv() },
  );
}

async function waitForReady(logFile, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev 提早結束(exit ${child.exitCode})`);
    const log = readFileSync(logFile, "utf8");
    if (/Ready on/.test(log)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev 在 ${READY_TIMEOUT_MS / 1000} 秒內沒有就緒`);
}

async function runCheck(base, check) {
  const response = await fetch(new URL(check.path, base), {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.arrayBuffer();
  const problems = [];
  if (response.status >= 500) problems.push(`伺服器錯誤 ${response.status}`);
  else if (response.status !== check.status) problems.push(`預期 ${check.status},實際 ${response.status}`);
  const location = response.headers.get("location");
  if (check.location) {
    const target = location ? new URL(location, base).pathname : null;
    if (target !== check.location) problems.push(`預期轉址到 ${check.location},實際 ${location ?? "(沒有)"}`);
  }
  return { status: response.status, location, problems };
}

// wrangler 開了自己的子程序(workerd);用獨立的程序群組啟動,停的時候整組一起停,
// 等它真的結束(最多 10 秒,之後強制)再刪暫存資料夾。
async function stop(child) {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // 整組已經不在了。
    }
  };
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
  signalGroup("SIGTERM");
  const timer = setTimeout(() => signalGroup("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
  // wrangler 結束之後,workerd 可能還在收尾;再補一次確保整組都停了。
  signalGroup("SIGKILL");
}

// 執行中被中斷(Ctrl-C、CI 取消)時,照樣停掉 wrangler 那一組程序、刪掉暫存資料夾,以非零結束。
const running = { child: null, tmp: null };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.error(`\n[boot] 被 ${signal} 中斷`);
    if (running.child) await stop(running.child);
    if (running.tmp) rmSync(running.tmp, { recursive: true, force: true });
    process.exit(1);
  });
}

// 選用拆分入口時,.open-next/split/ 必須是這一次 build 拆出來的;否則跑起來的是舊的 server 配新的
// middleware,檢查結果沒有意義。
function splitOutputProblem(configPath) {
  const config = unstable_readConfig({ config: configPath });
  if (path.resolve(config.main ?? "") !== path.join(root, "worker", "split-entry.ts")) return null;
  return fingerprintProblem(path.join(root, ".open-next"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stale = splitOutputProblem(args.config);
  if (stale) {
    console.error(`[boot] FAIL ${stale}`);
    process.exit(1);
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "worker-boot-"));
  running.tmp = tmp;
  const persistTo = path.join(tmp, "state");
  const logFile = path.join(tmp, "wrangler-dev.log");
  let child = null;
  let failed = false;
  try {
    applyMigrations(args.config, persistTo);
    const port = await freePort();
    const log = openSync(logFile, "w");
    child = spawn(
      process.execPath,
      [
        wrangler, "dev", "--config", args.config, "--local", "--port", String(port), "--ip", "127.0.0.1",
        "--persist-to", persistTo, "--test-scheduled", "--show-interactive-dev-session=false",
        "--infer-origin-from-routes=false",
      ],
      { cwd: root, stdio: ["ignore", log, log], env: wranglerEnv(), detached: true },
    );
    running.child = child;
    await waitForReady(logFile, child);

    const base = `http://127.0.0.1:${port}`;
    for (const check of CHECKS) {
      const result = await runCheck(base, check);
      const mark = result.problems.length === 0 ? "ok  " : "FAIL";
      const redirect = result.location ? ` → ${result.location}` : "";
      console.log(`[boot] ${mark} ${check.path} ${result.status}${redirect}${result.problems.length ? `(${result.problems.join(";")})` : ""}`);
      if (result.problems.length) failed = true;
    }
  } catch (error) {
    failed = true;
    console.error(`[boot] FAIL ${error.message}`);
  } finally {
    if (child) await stop(child);
  }
  if (failed) {
    let tail = "";
    try {
      tail = readFileSync(logFile, "utf8").split("\n").slice(-60).join("\n");
    } catch {
      tail = "(沒有 log)";
    }
    console.error(`\n[boot] 開機檢查失敗。wrangler dev 的 log 最後 60 行:\n${tail}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`[boot] FAIL ${error.stack ?? error.message}`);
  process.exit(1);
});
