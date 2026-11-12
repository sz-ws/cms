#!/usr/bin/env node
// 把 OpenNext 的 Next server 拆成很多個延後編譯的模組:pnpm 的 preview / deploy 在
// `opennextjs-cloudflare build` 之後、wrangler 之前跑這支。
//
// 只有選用 worker/split-entry.ts 當入口的站(wrangler.jsonc 的 `main`)才會真的拆;其他站
// 印一行「沒有選用」就結束,所以 cms 預設的 custom-worker.ts 不受影響。為什麼拆、怎麼量、
// 升級 OpenNext 時要重驗什麼,見 worker/README.md。
//
// 產出(.open-next/split/;OpenNext 自己的檔案一個都不改,預設入口照樣能用同一份 build):
//
//   worker.js               OpenNext 的 worker.js:相對 import 改指回 .open-next/,
//                           載入 server 的那一行改成非字面值的路徑(否則 esbuild 會把它併回主模組)
//   worker.d.ts             給 worker/split-entry.ts 的型別
//   server/handler.js       wrangler 打包好的 server 模組(chunk 與路由檔已經搬出去)
//   server/*.wasm           server 模組 import 的 wasm
//   server/chunks/*.cjs     每個 webpack chunk、每個路由檔各一個 CommonJS 模組
//   fingerprint.json        輸入檔(server handler 與 worker.js)的 sha256,認出沒有重新拆分的舊輸出
//                           (wrangler 的 rules 不收 .json,不會上傳)
//
// 不會留下半成品:一開始就刪掉舊的 .open-next/split/,全部寫在旁邊的暫存資料夾,成功才改名成
// .open-next/split/。中途失敗、被中斷,.open-next/split/ 都不存在,拆分入口的打包會直接失敗,
// 不會拿到拆了一半或上一次 build 的輸出。
//
// 用法:node scripts/split-server-chunks.mjs [--config <wrangler 設定檔>] [--force | --check]
//   --force  沒有選用也照拆(檢查拆分本身用)
//   --check  不拆,只確認 .open-next/split/ 是這一次 build 拆出來的(指紋對得上);
//            沒有選用的站直接通過。部署前跑這個,擋下 build 之後忘了拆分的組合。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { unstable_readConfig } from "wrangler";
import { WORKER_TYPES_STUB } from "./lib/worker-types-stub.mjs";
import { SplitError } from "./split-server/ast.mjs";
import { rewriteWorkerEntry, serverModuleImports } from "./split-server/entry.mjs";
import { FINGERPRINT_FILE, fingerprintOf, fingerprintProblem } from "./split-server/fingerprint.mjs";
import { loadNodeCompat } from "./split-server/preset.mjs";
import { CHUNK_DIR, splitServerHandler } from "./split-server/transform.mjs";

const root = path.resolve(import.meta.dirname, "..");
const openNext = path.join(root, ".open-next");
const outDir = path.join(openNext, "split");
const STAGING_PREFIX = "split.staging-";
const stagingDir = path.join(openNext, `${STAGING_PREFIX}${process.pid}`);
const serverDir = path.join(stagingDir, "server");
const buildDir = path.join(stagingDir, ".server-build");

const SPLIT_ENTRY = path.join(root, "worker", "split-entry.ts");
const SERVER_IMPORT = "./server-functions/default/handler.mjs";
const SERVER_TARGET = "./server/handler.js";
const REQUIRED_FLAG = "new_module_registry";

function cleanStaging() {
  rmSync(stagingDir, { recursive: true, force: true });
}

function fail(message) {
  cleanStaging();
  console.error(`\n[split] 失敗:${message}\n`);
  process.exit(1);
}

// 被中斷(Ctrl-C、CI 取消)時也清掉暫存資料夾;.open-next/split/ 在這之前已經刪掉了。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanStaging();
    console.error(`\n[split] 被 ${signal} 中斷,沒有產出。`);
    process.exit(1);
  });
}

function parseArgs(argv) {
  const args = { config: path.join(root, "wrangler.jsonc"), force: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--check") args.check = true;
    else if (argv[i] === "--config" && argv[i + 1]) args.config = path.resolve(argv[(i += 1)]);
    else fail(`不認得的參數 ${argv[i]}。用法:node scripts/split-server-chunks.mjs [--config <path>] [--force | --check]`);
  }
  return args;
}

function readSiteConfig(configPath) {
  try {
    return unstable_readConfig({ config: configPath });
  } catch (error) {
    return fail(`讀不到 wrangler 設定 ${configPath}:${error.message}`);
  }
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// server 要先由 wrangler 單獨打包一次:Node 內建模組的別名、wasm 的 import 都照 wrangler 的規則
// 解好,跟預設入口打包出來的一樣。設定只取站台的相容日期與旗標(打包結果取決於它們)。
function bundleServer(serverSource, config) {
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(buildDir, "handler.mjs"), serverSource);
  writeFileSync(path.join(buildDir, "server-entry.mjs"), 'export * from "./handler.mjs";\nexport default {};\n');
  writeFileSync(
    path.join(buildDir, "wrangler.json"),
    JSON.stringify({
      name: "split-server-build",
      main: "server-entry.mjs",
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags,
    }),
  );
  const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wrangler)) fail(`找不到 ${wrangler}。先跑 pnpm install。`);
  const out = path.join(buildDir, "out");
  try {
    execFileSync(
      process.execPath,
      [wrangler, "deploy", "--config", path.join(buildDir, "wrangler.json"), "--dry-run", "--outdir", out],
      { cwd: buildDir, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
  } catch (error) {
    fail(`wrangler 打包 server 模組失敗:\n${error.stderr?.toString() ?? error.message}`);
  }
  const bundled = path.join(out, "server-entry.js");
  if (!existsSync(bundled)) fail(`wrangler 沒有產出 ${bundled}(產出:${readdirSync(out).join(", ")})`);
  return { bundled, out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readSiteConfig(args.config);
  const optedIn = path.resolve(config.main ?? "") === SPLIT_ENTRY;
  if (args.check) {
    if (!optedIn) {
      console.log(`[split] ${path.relative(root, args.config)} 的 main 不是 worker/split-entry.ts,不需要拆分輸出。`);
      return;
    }
    const problem = fingerprintProblem(openNext);
    if (problem) fail(problem);
    console.log("[split] .open-next/split/ 跟這一次 build 對得上。");
    return;
  }
  if (!optedIn && !args.force) {
    console.log(`[split] ${path.relative(root, args.config)} 的 main 不是 worker/split-entry.ts,不拆分。`);
    return;
  }
  if (optedIn && !(config.compatibility_flags ?? []).includes(REQUIRED_FLAG)) {
    fail(
      `worker/split-entry.ts 需要 compatibility_flags 裡的 "${REQUIRED_FLAG}":沒有它,server 模組的 ` +
        "import.meta.url 是 undefined,每個需要 Next server 的請求都會失敗。見 worker/README.md。",
    );
  }

  const handlerPath = path.join(openNext, "server-functions", "default", "handler.mjs");
  const workerPath = path.join(openNext, "worker.js");
  for (const file of [handlerPath, workerPath]) {
    if (!existsSync(file)) fail(`找不到 ${path.relative(root, file)}。先跑 opennextjs-cloudflare build。`);
  }

  const started = Date.now();
  // 舊的輸出屬於上一次 build,先刪;之前被中斷而留下的暫存資料夾也一起刪。
  rmSync(outDir, { recursive: true, force: true });
  for (const entry of readdirSync(openNext)) {
    if (entry.startsWith(STAGING_PREFIX)) rmSync(path.join(openNext, entry), { recursive: true, force: true });
  }
  mkdirSync(path.join(serverDir, CHUNK_DIR), { recursive: true });

  let split;
  let worker;
  let wasm;
  let bundled;
  let out;
  let fingerprint;
  try {
    const compat = await loadNodeCompat(root, config);
    const handlerBytes = readFileSync(handlerPath);
    const workerBytes = readFileSync(workerPath);
    // 指紋用拆分實際讀到的內容算,不另外再讀一次。
    fingerprint = fingerprintOf(handlerBytes, workerBytes);
    split = splitServerHandler(handlerBytes.toString("utf8"), compat);
    worker = rewriteWorkerEntry(workerBytes.toString("utf8"), {
      importPrefix: "..",
      serverImport: SERVER_IMPORT,
      serverTarget: SERVER_TARGET,
    });
    for (const mod of split.modules) writeFileSync(path.join(serverDir, CHUNK_DIR, mod.file), mod.source);
    ({ bundled, out } = bundleServer(split.server, config));
    wasm = serverModuleImports(readFileSync(bundled, "utf8"), [".wasm"]);
  } catch (error) {
    if (error instanceof SplitError) fail(`${error.message}\n見 worker/README.md 的「失敗時」與「升級 OpenNext 或 Next 時」。`);
    cleanStaging();
    throw error;
  }

  try {
    copyFileSync(bundled, path.join(serverDir, "handler.js"));
    for (const file of wasm) {
      const from = path.join(out, file);
      if (!existsSync(from)) fail(`server 模組 import 的 ${file} 不在 wrangler 的產出裡。`);
      copyFileSync(from, path.join(serverDir, file));
    }
    rmSync(buildDir, { recursive: true, force: true });
    writeFileSync(path.join(stagingDir, "worker.d.ts"), WORKER_TYPES_STUB);
    writeFileSync(path.join(stagingDir, FINGERPRINT_FILE), `${JSON.stringify(fingerprint, null, 2)}\n`);
    writeFileSync(path.join(stagingDir, "worker.js"), worker);
    renameSync(stagingDir, outDir);
  } catch (error) {
    cleanStaging();
    throw error;
  }

  const serverBytes = statSync(path.join(outDir, "server", "handler.js")).size;
  const chunkBytes = split.modules.reduce((sum, mod) => sum + Buffer.byteLength(mod.source), 0);
  const wasmBytes = wasm.reduce((sum, file) => sum + statSync(path.join(outDir, "server", file)).size, 0);
  const chunks = split.modules.filter((mod) => mod.kind === "chunk").length;
  console.log(
    [
      `[split] .open-next/split/ 完成(${((Date.now() - started) / 1000).toFixed(1)} 秒)`,
      `  server 模組      ${mib(serverBytes)}(${serverBytes} bytes)`,
      `  延後編譯的模組  ${split.modules.length} 個(chunk ${chunks}、路由檔 ${split.modules.length - chunks}),共 ${mib(chunkBytes)}`,
      `  wasm            ${wasm.length} 個,共 ${mib(wasmBytes)}`,
      `  合計            ${mib(serverBytes + chunkBytes + wasmBytes)}`,
      `  接橋的名字      ${split.bridged.length} 個;留在 server 裡的包裝 ${split.kept} 個`,
      `  搬出去的 require ${split.requires.length} 個模組名稱` +
        (split.optionalRequires.length ? `;只在 try 裡的選用套件:${split.optionalRequires.join("、")}` : ""),
    ].join("\n"),
  );
}

await main();
