#!/usr/bin/env node
// sz-cms —— sz.ws CMS 的命令列工具。
//
//   add <id>   code-extension 安裝器:讀 registry 索引 → 抓 extensions/<id>/files/*
//              → 寫本機 extensions/<id>/ → patch extensions/registry.ts。
//   setup      把 repo 接上自己的 Cloudflare 帳號:建 D1 / R2、回填 wrangler.jsonc、
//              套 migrations、設 SECRETS_KEY(見 setup.ts)。

import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";
import { parseArgs, ID_RE, type ParsedArgs } from "./args.js";
import {
  DEFAULT_SOURCE,
  fetchIndex,
  type IndexEntry,
  type SourceConfig,
} from "./registry.js";
import {
  resolveFiles,
  fetchAndWriteFiles,
  removeDir,
  hasNamedExport,
  heuristicWarnings,
} from "./install.js";
import {
  readCoreApiVersion,
  checkCoreApi,
  CORE_VERSION_FILE,
} from "./coreapi.js";
import { patchRegistryContent, camelCaseId } from "./patch.js";
import { EXIT } from "./exit.js";
import { resolveWranglerCommand, spawnExecutor } from "./exec.js";
import { WranglerClient } from "./wrangler.js";
import { runSetup } from "./setup.js";
import { createUi } from "./ui.js";

export const VERSION = "0.2.0";

// 結束狀態碼定義搬到 exit.ts(setup.ts 也要用,避免循環相依);
// 這裡 re-export,`import { EXIT } from "./cli.js"` 的既有契約不變。
export { EXIT } from "./exit.js";

export const DEFAULT_CONFIG_FILE = "wrangler.jsonc";

const USAGE = `用法:
  sz-cms add <id> [--source <url>] [--token <t>] [--dry-run] [--force]
                  [--non-interactive] [--skip-core-check]
  sz-cms setup    [--config <path>] [--dry-run] [--yes]
                  [--skip-migrations] [--skip-secrets]

add —— 安裝 code extension
  <id>                安裝的 extension id(^[a-z][a-z0-9-]{1,30}$)
  --source <url>      registry base URL(預設 ${DEFAULT_SOURCE})
  --token <t>         registry 存取 token(private repo;亦讀 SZWS_REGISTRY_TOKEN)
  --force             覆寫已存在的 extensions/<id>/
  --skip-core-check   跳過 coreApi 相容性檢查(明知故犯用)

setup —— 接上你自己的 Cloudflare 帳號(建 D1/R2、回填設定檔、套 migrations、設 secret)
  --config <path>     wrangler 設定檔路徑(預設 ./${DEFAULT_CONFIG_FILE})
  --skip-migrations   不套用 migrations/
  --skip-secrets      不處理 SECRETS_KEY

共用
  --dry-run           只偵測與列出將做的事,不建立資源 / 不寫檔
  --yes, -y           略過所有確認關卡(CI 用)
  --non-interactive   不互動(add 時隱含 --force;setup 時等同 --yes)
  --help, --version`;

function log(msg = ""): void {
  process.stdout.write(`${msg}\n`);
}
function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
/** 警告 —— 不中止,但走 stderr,別讓它混進被導向的 stdout 裡消失。 */
function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function nextSteps(
  id: string,
  fileCount: number,
  patchNote: string,
  heuristic: boolean,
): void {
  log();
  log(`✓ 複製了 ${fileCount} 個檔到 extensions/${id}/`);
  log(`✓ ${patchNote}`);
  if (heuristic) {
    // 「✓ 複製了 N 個檔」單看很像「抓全了」。啟發式模式沒有這個保證,再講一次。
    log(
      `⚠ 這 ${fileCount} 個檔是猜檔名猜出來的(registry 沒給 files[]),` +
        "可能不完整 —— 子目錄一定沒抓到。",
    );
  }
  log();
  // 順序在正式站是硬性的:Enable 讀的是**編譯期**的 registry 陣列,所以必須先
  // deploy 過、新的 bundle 上線之後才啟用得了。而 code extension 的 migrations 是
  // enableExtension() 在 worker 內用單一 D1 batch 跑的(src/ext/manager.ts),
  // 不是 `wrangler d1 migrations apply` —— 那支只管 core 自己的 migrations/。
  log("接下來(CLI 不代跑):");
  log("  1. pnpm build && pnpm deploy       # Enable 讀編譯期 registry,必須先上線");
  log("  2. admin → Extensions → Installed → Enable");
  log("     (此 extension 自帶的 migrations 會在這一步以單一 D1 batch 原子執行)");
  log("  3. 需要外部伴侶的(cron 之類):另見該 extension 的部署說明。");
}

export async function run(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs(argv);

  if (args.version) {
    log(VERSION);
    return EXIT.OK;
  }
  if (args.help) {
    log(USAGE);
    return EXIT.OK;
  }
  if (args.error) {
    err(`✗ ${args.error}`);
    err(USAGE);
    return EXIT.NOT_FOUND;
  }
  if (args.command === "setup") return runSetupCommand(args, cwd);
  if (args.command !== "add") {
    err(`✗ 未知指令:${args.command ?? "(無)"}`);
    err(USAGE);
    return EXIT.NOT_FOUND;
  }
  return runAdd(args, cwd);
}

/**
 * `setup` 的接線:把真實的 spawn executor 包成 WranglerClient,再交給純流程邏輯。
 * 流程本身(setup.ts)完全不知道子程序長什麼樣,所以測試注入假的就能整條跑完。
 */
async function runSetupCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const { cmd, prefix } = resolveWranglerCommand(cwd);
  const assumeYes = args.yes || args.nonInteractive;
  const ui = createUi({
    interactive: !assumeYes && process.stdin.isTTY === true,
  });
  const configPath = args.config
    ? path.resolve(cwd, args.config)
    : path.join(cwd, DEFAULT_CONFIG_FILE);

  return runSetup({
    cwd,
    configPath,
    client: new WranglerClient({
      exec: spawnExecutor,
      cwd,
      cmd,
      prefix,
      dryRun: args.dryRun,
      // wrangler 的 --config 只在使用者明確指定時才傳,否則沿用它自己的搜尋規則。
      configPath: args.config ? configPath : undefined,
    }),
    reporter: ui.reporter,
    prompter: ui.prompter,
    dryRun: args.dryRun,
    assumeYes,
    skipMigrations: args.skipMigrations,
    skipSecrets: args.skipSecrets,
  });
}

async function runAdd(args: ParsedArgs, cwd: string): Promise<number> {
  const id = args.id;
  if (!id) {
    err("✗ 缺少 <id>。");
    err(USAGE);
    return EXIT.NOT_FOUND;
  }
  if (!ID_RE.test(id)) {
    err(
      `✗ 無效的 extension id:「${id}」。` +
        "必須符合 ^[a-z][a-z0-9-]{1,30}$(不得含 /、.. 等路徑字元)。",
    );
    return EXIT.NOT_FOUND;
  }

  // registry.ts 必須在 cwd —— 先確認在 CMS repo 根目錄。
  const registryPath = path.join(cwd, "extensions", "registry.ts");
  if (!(await exists(registryPath))) {
    err(
      "✗ 找不到 extensions/registry.ts。" +
        "請確認你在 CMS repo 根目錄執行 `sz-cms add`。",
    );
    return EXIT.PATCH_FAILED;
  }

  // ---- sources ----
  const token = args.token ?? process.env.SZWS_REGISTRY_TOKEN;
  const sources: SourceConfig[] = [
    { url: args.source ?? DEFAULT_SOURCE, token },
  ];

  // ---- 讀 index ----
  const { entries, errors } = await fetchIndex(sources);
  const matches = entries.filter((e) => e.id === id);

  if (matches.length === 0) {
    // 全源失敗 → 抓檔失敗(exit 2);否則 index 有讀到但無此 id(exit 1)。
    if (errors.length === sources.length && entries.length === 0) {
      // GitHub 對 private repo 的 raw 請求回 404(不是 401)以避免洩漏 repo 存在性
      // —— 無 token 時的 404 一樣要指路,否則 GitHub private 永遠觸發不了提示。
      const tokenless404 = !token
        ? errors.find((e) => e.status === 404)
        : undefined;
      const auth =
        errors.find((e) => e.status === 401 || e.status === 403) ?? tokenless404;
      if (auth) {
        err(
          `✗ registry 回應 ${auth.status}${auth.status === 404 ? "" : "(未授權)"}:${auth.source}`,
        );
        err(
          "  這個 registry 可能是 private repo(GitHub 對未授權的 private raw 回 404)。請提供 token:",
        );
        err("    sz-cms add <id> --token <你的 token>");
        err("    或設環境變數 SZWS_REGISTRY_TOKEN=<你的 token>");
        err("  GitHub PAT / Gitea deploy token 皆可(送出時為 `Authorization: token <t>`)。");
        return EXIT.FETCH_FAILED;
      }
      for (const e of errors) {
        err(`✗ 讀取 registry 失敗(${e.source}):${e.error}`);
      }
      return EXIT.FETCH_FAILED;
    }
    err(`✗ registry 索引裡找不到 id「${id}」。`);
    if (entries.length > 0) {
      const ids = [...new Set(entries.map((e) => e.id))].sort();
      err(`  可用的 id:${ids.join(", ")}`);
    }
    return EXIT.NOT_FOUND;
  }

  // 同 id 出現在多個不同 source → 讓使用者用 --source 挑。
  const distinctSources = [...new Set(matches.map((m) => m.source))];
  if (distinctSources.length > 1) {
    err(`✗ id「${id}」在多個 source 都存在,請用 --source 指定其一:`);
    for (const s of distinctSources) err(`    ${s}`);
    return EXIT.NOT_FOUND;
  }

  const entry: IndexEntry = matches[0];
  const source = entry.source;

  // declarative → 走 admin UI,不是這支 CLI 的範疇。
  if (entry.kind !== "code") {
    log(
      `「${id}」是 declarative extension(kind=${entry.kind})。`,
    );
    log(
      "declarative 走 admin UI 的 Browse → Install 熱裝,不需要 `sz-cms add`。",
    );
    return EXIT.OK;
  }

  // ---- coreApi 相容性 ----
  // 沒有這關的話,不相容的 extension 會一路裝完 → rebuild → deploy,直到 admin 按
  // Enable 那刻才被 src/ext/manager.ts 的 enableExtension() 丟 CoreApiIncompatible。
  // 失敗點離錯誤來源太遠,所以提前到安裝當下。
  const verdict = checkCoreApi(await readCoreApiVersion(cwd), entry.coreApi);
  if (verdict.status === "unknown") {
    // 讀不到本機版號(版號檔搬家 / 形狀改了)→ 不擋。這是 CLI 讀不到資訊,不是使用者的錯;
    // 真不相容的話 Enable 那步仍有 core 把關。
    warn(
      `⚠ 讀不到本機 core 版號(${CORE_VERSION_FILE} 的 CORE_API_VERSION),` +
        "略過 coreApi 相容性檢查。",
    );
    warn(`  「${id}」宣告需要 core API「${entry.coreApi}」,請自行確認。`);
  } else if (verdict.status === "incompatible") {
    if (args.skipCoreCheck) {
      warn(
        `⚠ coreApi 不相容(需要「${entry.coreApi}」,本機 core ${verdict.core}),` +
          "因 --skip-core-check 繼續安裝。",
      );
      warn("  裝完之後 admin 按 Enable 仍可能被 core 擋下(CoreApiIncompatible)。");
    } else {
      err(
        `✗ 「${id}」需要 core API「${entry.coreApi}」,本機 core 是 ${verdict.core}` +
          `(${CORE_VERSION_FILE})。`,
      );
      if (verdict.unsupportedRange) {
        err(
          "  這個 coreApi range 的形式 core 也解析不了(只支援 1.2.3 / ^1.2.3 / ~1.2.3 / >=1.2.3),",
        );
        err("  而 core 對解析不了的 range 一律視為不相容。請 extension 作者修正 manifest。");
      }
      err("  現在擋下來,是因為裝下去、rebuild、deploy 之後,admin 按 Enable 時");
      err("  enableExtension() 一樣會丟 CoreApiIncompatible —— 不如現在就失敗。");
      err("  可以:");
      err("    1. 把本機 CMS core 升到滿足此 range 的版本");
      err("    2. 改裝這個 extension 支援目前 core 的版本");
      err("    3. 你確定自己在做什麼(squash 期間 / 本機改過版號):加 --skip-core-check");
      return EXIT.CORE_INCOMPATIBLE;
    }
  }

  // ---- 目標目錄存在性 ----
  const destDir = path.join(cwd, "extensions", id);
  const destExists = await exists(destDir);
  // --non-interactive 隱含 --force。
  let force = args.force || args.nonInteractive;

  if (destExists && !force && !args.dryRun) {
    const interactive = process.stdin.isTTY && !args.nonInteractive;
    if (interactive) {
      const ok = await confirm(`extensions/${id}/ 已存在,要覆寫嗎?`);
      if (!ok) {
        err("✗ 已中止(未覆寫)。");
        return EXIT.DEST_EXISTS;
      }
      force = true;
    } else {
      err(
        `✗ extensions/${id}/ 已存在。加 --force 覆寫,或先手動移除。`,
      );
      return EXIT.DEST_EXISTS;
    }
  }

  // ---- 解析 + 抓檔 ----
  let resolved;
  try {
    resolved = await resolveFiles(source, entry, token);
  } catch (e) {
    err(`✗ 無法決定要抓哪些檔:${e instanceof Error ? e.message : String(e)}`);
    return EXIT.FETCH_FAILED;
  }

  if (resolved.heuristic) {
    for (const line of heuristicWarnings(id, resolved.files)) warn(line);
  }

  const ident = camelCaseId(id);

  if (args.dryRun) {
    log(`[dry-run] 將安裝 code extension「${id}」(${entry.name} v${entry.version})`);
    log(`[dry-run] 來源:${source}`);
    if (verdict.status === "ok") {
      log(
        `[dry-run] coreApi 相容:需要 ${entry.coreApi},本機 core ${verdict.core}`,
      );
    }
    if (destExists) {
      log(`[dry-run] extensions/${id}/ 已存在 —— 實跑需 --force 覆寫。`);
    }
    log(
      `[dry-run] 將寫入 ${resolved.files.length} 個檔${
        resolved.heuristic ? "(啟發式猜檔名)" : ""
      }:`,
    );
    for (const f of resolved.files) log(`             extensions/${id}/${f}`);
    // 預覽 patch(不寫檔)。
    const original = await readFile(registryPath, "utf8");
    const patch = patchRegistryContent(original, id);
    if (!patch.ok) {
      log(`[dry-run] registry.ts patch 會失敗(${patch.reason}),需手動插入:`);
      log(`             ${patch.importLine}`);
      log(`             registry 陣列加入:${patch.ident}`);
    } else if (patch.alreadyUpToDate) {
      log("[dry-run] registry.ts 已含此 extension(idempotent,不會改動)。");
    } else {
      log("[dry-run] 會 patch extensions/registry.ts:");
      if (patch.importAdded) log(`             + import { ${ident} } from "./${id}";`);
      if (patch.arrayAdded) log(`             + registry 陣列加入 ${ident}`);
    }
    return EXIT.OK;
  }

  if (destExists && force) {
    await removeDir(destDir);
  }

  let written;
  try {
    written = await fetchAndWriteFiles({
      source,
      entry,
      token,
      files: resolved.files,
      destDir,
      dryRun: false,
    });
  } catch (e) {
    err(
      `✗ 抓檔失敗:${e instanceof Error ? e.message : String(e)}`,
    );
    err(
      "  已寫入的檔保留(部分安裝)。請檢查 registry 此 extension 是否完整。",
    );
    return EXIT.FETCH_FAILED;
  }

  // ---- 驗證 index.ts named export ----
  const indexFile = written.find((f) => f.rel === "index.ts");
  if (!indexFile || !hasNamedExport(indexFile.content, id)) {
    err(
      `✗ extensions/${id}/index.ts 缺少名為「${ident}」的 named export,無法接線。`,
    );
    err(
      `  registry.ts 需要 \`import { ${ident} } from "./${id}"\`;請確認此 extension 的 index.ts。`,
    );
    return EXIT.PATCH_FAILED;
  }

  // ---- patch registry.ts ----
  const original = await readFile(registryPath, "utf8");
  const patch = patchRegistryContent(original, id);
  if (!patch.ok) {
    err("✗ 無法自動 patch extensions/registry.ts(格式辨識不出來)。");
    err("  請手動插入以下兩處:");
    err(`    ${patch.importLine}`);
    err(`    在 registry 陣列末端加入:${patch.ident}`);
    return EXIT.PATCH_FAILED;
  }

  let patchNote: string;
  if (patch.alreadyUpToDate) {
    patchNote = "extensions/registry.ts 已是最新(idempotent,未改動)";
  } else {
    await writeFile(registryPath, patch.content, "utf8");
    const parts: string[] = [];
    if (patch.importAdded) parts.push("加了 import");
    if (patch.arrayAdded) parts.push("加進 registry 陣列");
    patchNote = `Patch 了 extensions/registry.ts(${parts.join(" + ")})`;
  }

  nextSteps(id, written.length, patchNote, resolved.heuristic);
  return EXIT.OK;
}

// 直接執行(bin)時跑 main;被 import(測試)時不跑。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  run(process.argv.slice(2), process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      err(`✗ 未預期錯誤:${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = EXIT.UNKNOWN;
    });
}
