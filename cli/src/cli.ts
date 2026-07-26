#!/usr/bin/env node
// sz-ws-cms —— sz.ws CMS 的命令列工具。
//
//   add <id>   code-extension 安裝器:讀 registry 索引 → 抓 extensions/<id>/files/*
//              → 寫本機 extensions/<id>/ → patch extensions/registry.ts。
//   setup      把 repo 接上自己的 Cloudflare 帳號:建 D1 / R2、回填 wrangler.jsonc、
//              套 migrations、設 SECRETS_KEY(見 setup.ts)。

import { readFile, writeFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { createUi, type UiEvent } from "./ui.js";

export const VERSION = "0.2.1";

// 結束狀態碼定義搬到 exit.ts(setup.ts 也要用,避免循環相依);
// 這裡 re-export,`import { EXIT } from "./cli.js"` 的既有契約不變。
export { EXIT } from "./exit.js";

export const DEFAULT_CONFIG_FILE = "wrangler.jsonc";

const USAGE = `@sz.ws/cms v${VERSION} — sz.ws CMS command-line tool

Usage:
  cms setup [options]           connect this repo to your Cloudflare account
  cms add <id> [options]        install a code extension
  cms help                      show this help
  cms version                   show version

setup options:
  --config <path>               wrangler config file path (default ./${DEFAULT_CONFIG_FILE})
  --site-slug <slug>            new site id (3–48 lowercase alnum/hyphen);
                                Worker, D1 and R2 names derive from it
  --allow-shared-default-names  allow the shipped shared names (cms, cms-db, …);
                                single-site or dev accounts only — on a
                                multi-tenant account this causes cross-site access
  --skip-migrations             skip applying migrations/
  --skip-secrets                skip setting SECRETS_KEY / AUTH_PEPPER / SETUP_TOKEN

add options:
  --source <url>                registry base URL
                                (default ${DEFAULT_SOURCE})
  --token <t>                   registry access token (private repos)
  --force                       overwrite existing extensions/<id>/
  --skip-core-check             skip coreApi compatibility check (use with caution)

shared options:
  --dry-run                     list what would be done; create nothing, write nothing
  --yes, -y                     skip all confirmations (CI use)
  --non-interactive             no prompts (add: implies --force; setup: same as --yes)
  --json                        stdout gets a single machine-readable JSON
                                human output goes to stderr as normal

examples:
  npx @sz.ws/cms setup --site-slug acme-taipei
  npx @sz.ws/cms setup --dry-run
  npx @sz.ws/cms add blog
  npx @sz.ws/cms add cron --token "$SZWS_REGISTRY_TOKEN"

environment variables:
  SZWS_REGISTRY_TOKEN           registry access token (same as --token)
  CLOUDFLARE_ACCOUNT_ID         specify which account to use when logged in to multiple

docs: https://sz.ws`;

// 輸出分流(對齊 @sz-ws/drop):**人看的東西一律 stderr**,stdout 只留給結果。
// 原本 log() 寫 stdout,於是 `cms add blog | something` 拿到的是進度訊息而不是
// 結果,而 `> log.txt` 只留得住一半的輸出(err/warn 走另一邊)。
//
// --json 時另外把每一行收進 transcript,最後由 emitJson 一次吐到 stdout ——
// 這支 CLI 的「結果」本來就是一連串步驟,硬要為每條 return 路徑再定義一個
// 結果型別,是把流程改一遍去遷就輸出格式。
let transcript: string[] | null = null;

function log(msg = ""): void {
  transcript?.push(msg);
  process.stderr.write(`${msg}\n`);
}
function err(msg: string): void {
  transcript?.push(msg);
  process.stderr.write(`${msg}\n`);
}
/** 警告 —— 不中止,但同樣進 transcript,別讓它在機器可讀輸出裡消失。 */
function warn(msg: string): void {
  transcript?.push(msg);
  process.stderr.write(`${msg}\n`);
}

/** stdout 的唯一使用者。 */
function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
    output: process.stderr,
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
  log(`✓ copied ${fileCount} files to extensions/${id}/`);
  log(`✓ ${patchNote}`);
  if (heuristic) {
    // 「✓ 複製了 N 個檔」單看很像「抓全了」。啟發式模式沒有這個保證,再講一次。
    log(
      `⚠ these ${fileCount} files were guessed by name (registry didn't provide files[]),` +
        " may be incomplete — subdirectories definitely not included.",
    );
  }
  log();
  // 順序在正式站是硬性的:Enable 讀的是**編譯期**的 registry 陣列,所以必須先
  // deploy 過、新的 bundle 上線之後才啟用得了。而 code extension 的 migrations 是
  // enableExtension() 在 worker 內用單一 D1 batch 跑的(src/ext/manager.ts),
  // 不是 `wrangler d1 migrations apply` —— 那支只管 core 自己的 migrations/。
  log("next steps (not automated by this CLI):");
  log("  1. pnpm build && pnpm run deploy       # Enable reads compile-time registry, must deploy first");
  log("  2. admin → Extensions → Installed → Enable");
  log("     (extension-specific migrations run here as a single D1 batch)");
  log("  3. for external integrations (like cron): see that extension's deployment guide.");
}

export async function run(argv: string[], cwd: string): Promise<number> {
  const args = parseArgs(argv);

  // --version / --help 是「被問就答」,答案本身就是結果 —— 這兩個照樣走 stdout,
  // 否則 `cms version` 沒辦法被 shell 取值,那是這類指令唯一的用途。
  if (args.version) {
    process.stdout.write(`@sz.ws/cms v${VERSION}\n`);
    return EXIT.OK;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  transcript = args.json ? [] : null;
  const code = await dispatch(args, cwd);
  if (args.json) {
    emitJson({
      ok: code === EXIT.OK,
      exitCode: code,
      command: args.command ?? null,
      ...(args.command === "add" && args.id ? { id: args.id } : {}),
      ...(setupEvents ? { events: setupEvents } : {}),
      messages: transcript ?? [],
    });
  }
  transcript = null;
  setupEvents = null;
  return code;
}

/** setup 走 Reporter,事件比純文字精確,--json 時優先用它。 */
let setupEvents: UiEvent[] | null = null;

async function dispatch(args: ParsedArgs, cwd: string): Promise<number> {
  if (args.error) {
    err(`✗ ${args.error}`);
    err(USAGE);
    return EXIT.NOT_FOUND;
  }
  if (args.command === "setup") return runSetupCommand(args, cwd);
  if (args.command !== "add") {
    err(`✗ unknown command: ${args.command ?? "(none)"}`);
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
    json: args.json,
  });
  setupEvents = ui.events;
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
    siteSlug: args.siteSlug,
    allowSharedDefaultNames: args.allowSharedDefaultNames,
  });
}

async function runAdd(args: ParsedArgs, cwd: string): Promise<number> {
  const id = args.id;
  if (!id) {
    err("✗ missing <id>");
    err(USAGE);
    return EXIT.NOT_FOUND;
  }
  if (!ID_RE.test(id)) {
    err(
      `✗ invalid extension id: "${id}"` +
        " must match ^[a-z][a-z0-9-]{1,30}$ (no /, .., or other path characters).",
    );
    return EXIT.NOT_FOUND;
  }

  // registry.ts 必須在 cwd —— 先確認在 CMS repo 根目錄。
  const registryPath = path.join(cwd, "extensions", "registry.ts");
  if (!(await exists(registryPath))) {
    err(
      "✗ could not find extensions/registry.ts" +
        " — make sure you are running `sz-ws-cms add` from the CMS repo root.",
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
          `✗ registry responded with ${auth.status}${auth.status === 404 ? "" : " (unauthorized)"}: ${auth.source}`,
        );
        err(
          "  this registry may be a private repo (GitHub returns 404 for unauthorized private raw). provide a token:",
        );
        err("    sz-ws-cms add <id> --token <your-token>");
        err("    or set env var SZWS_REGISTRY_TOKEN=<your-token>");
        err("  GitHub PAT or Gitea deploy token both work (sent as `Authorization: token <t>`).");
        return EXIT.FETCH_FAILED;
      }
      for (const e of errors) {
        err(`✗ failed to read registry (${e.source}): ${e.error}`);
      }
      return EXIT.FETCH_FAILED;
    }
    err(`✗ id "${id}" not found in registry index.`);
    if (entries.length > 0) {
      const ids = [...new Set(entries.map((e) => e.id))].sort();
      err(`  available ids: ${ids.join(", ")}`);
    }
    return EXIT.NOT_FOUND;
  }

  // 同 id 出現在多個不同 source → 讓使用者用 --source 挑。
  const distinctSources = [...new Set(matches.map((m) => m.source))];
  if (distinctSources.length > 1) {
    err(`✗ id "${id}" exists in multiple sources, use --source to pick one:`);
    for (const s of distinctSources) err(`    ${s}`);
    return EXIT.NOT_FOUND;
  }

  const entry: IndexEntry = matches[0];
  const source = entry.source;

  // declarative → 走 admin UI,不是這支 CLI 的範疇。
  if (entry.kind !== "code") {
    log(
      `"${id}" is a declarative extension (kind=${entry.kind}).`,
    );
    log(
      "declarative extensions are hot-installed via admin UI (Browse → Install), `sz-ws-cms add` not needed.",
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
      `⚠ could not read local core version (CORE_API_VERSION in ${CORE_VERSION_FILE}),` +
        " skipping coreApi compatibility check.",
    );
    warn(`  "${id}" requires core API "${entry.coreApi}", please verify manually.`);
  } else if (verdict.status === "incompatible") {
    if (args.skipCoreCheck) {
      warn(
        `⚠ coreApi incompatible (requires "${entry.coreApi}", local core is ${verdict.core}),` +
          " continuing due to --skip-core-check.",
      );
      warn("  enable may still be blocked by core (CoreApiIncompatible) in admin.");
    } else {
      err(
        `✗ "${id}" requires core API "${entry.coreApi}", local core is ${verdict.core}` +
          ` (${CORE_VERSION_FILE}).`,
      );
      if (verdict.unsupportedRange) {
        err(
          "  this coreApi range format is not supported by core either (only 1.2.3 / ^1.2.3 / ~1.2.3 / >=1.2.3),",
        );
        err("  and core treats unsupported ranges as incompatible. please have the extension author fix the manifest.");
      }
      err("  blocking now because after install, rebuild, and deploy, enable would fail anyway");
      err("  with CoreApiIncompatible from enableExtension() — fail fast instead.");
      err("  you can:");
      err("    1. upgrade local CMS core to satisfy this range");
      err("    2. downgrade this extension to support current core version");
      err("    3. if you know what you're doing (squash period / local version change): add --skip-core-check");
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
      const ok = await confirm(`extensions/${id}/ already exists, overwrite?`);
      if (!ok) {
        err("✗ cancelled (not overwritten).");
        return EXIT.DEST_EXISTS;
      }
      force = true;
    } else {
      err(
        `✗ extensions/${id}/ already exists. add --force to overwrite or remove manually.`,
      );
      return EXIT.DEST_EXISTS;
    }
  }

  // ---- 解析 + 抓檔 ----
  let resolved;
  try {
    resolved = await resolveFiles(source, entry, token);
  } catch (e) {
    err(`✗ could not determine which files to fetch: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.FETCH_FAILED;
  }

  if (resolved.heuristic) {
    for (const line of heuristicWarnings(id, resolved.files)) warn(line);
  }

  const ident = camelCaseId(id);

  if (args.dryRun) {
    log(`[dry-run] will install code extension "${id}" (${entry.name} v${entry.version})`);
    log(`[dry-run] source: ${source}`);
    if (verdict.status === "ok") {
      log(
        `[dry-run] coreApi compatible: requires ${entry.coreApi}, local core is ${verdict.core}`,
      );
    }
    if (destExists) {
      log(`[dry-run] extensions/${id}/ already exists — --force needed to overwrite.`);
    }
    log(
      `[dry-run] will write ${resolved.files.length} files${
        resolved.heuristic ? " (guessed filenames)" : ""
      }:`,
    );
    for (const f of resolved.files) log(`             extensions/${id}/${f}`);
    // 預覽 patch(不寫檔)。
    const original = await readFile(registryPath, "utf8");
    const patch = patchRegistryContent(original, id);
    if (!patch.ok) {
      log(`[dry-run] registry.ts patch would fail (${patch.reason}), manual insertion needed:`);
      log(`             ${patch.importLine}`);
      log(`             add to registry array: ${patch.ident}`);
    } else if (patch.alreadyUpToDate) {
      log("[dry-run] registry.ts already contains this extension (idempotent, no changes).");
    } else {
      log("[dry-run] will patch extensions/registry.ts:");
      if (patch.importAdded) log(`             + import { ${ident} } from "./${id}";`);
      if (patch.arrayAdded) log(`             + add ${ident} to registry array`);
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
      `✗ failed to fetch files: ${e instanceof Error ? e.message : String(e)}`,
    );
    err(
      "  partially written files remain (partial install). check if this extension is complete in the registry.",
    );
    return EXIT.FETCH_FAILED;
  }

  // ---- 驗證 index.ts named export ----
  const indexFile = written.find((f) => f.rel === "index.ts");
  if (!indexFile || !hasNamedExport(indexFile.content, id)) {
    err(
      `✗ extensions/${id}/index.ts missing named export "${ident}", cannot wire up.`,
    );
    err(
      `  registry.ts needs \`import { ${ident} } from "./${id}"\`; verify this extension's index.ts.`,
    );
    return EXIT.PATCH_FAILED;
  }

  // ---- patch registry.ts ----
  const original = await readFile(registryPath, "utf8");
  const patch = patchRegistryContent(original, id);
  if (!patch.ok) {
    err("✗ could not automatically patch extensions/registry.ts (format not recognized).");
    err("  manual insertion needed in two places:");
    err(`    ${patch.importLine}`);
    err(`    add to end of registry array: ${patch.ident}`);
    return EXIT.PATCH_FAILED;
  }

  let patchNote: string;
  if (patch.alreadyUpToDate) {
    patchNote = "extensions/registry.ts up to date (idempotent, no changes)";
  } else {
    await writeFile(registryPath, patch.content, "utf8");
    const parts: string[] = [];
    if (patch.importAdded) parts.push("added import");
    if (patch.arrayAdded) parts.push("added to registry array");
    patchNote = `patched extensions/registry.ts (${parts.join(" + ")})`;
  }

  nextSteps(id, written.length, patchNote, resolved.heuristic);
  return EXIT.OK;
}

/**
 * 直接執行(bin)時跑 main;被 import(測試)時不跑。
 *
 * 曾經寫的是 `import.meta.url === \`file://${process.argv[1]}\``,而那個比較在
 * **實際安裝之後永遠不成立**:npm 把 bin 連成 node_modules/.bin/cms → 真實檔案的
 * symlink,所以 argv[1] 是那條 symlink,import.meta.url 卻是 Node 解析過的真實
 * 路徑。兩者不相等 → main 不跑 → 每個指令都靜默 exit 0 什麼都不做。
 * 本機 `node dist/cli.js` 測得到、裝起來就死,而且死得像成功。
 *
 * 順帶修掉同一行的第二個問題:`file://${path}` 沒有做 URL 編碼,路徑含空白或
 * 非 ASCII 時字串同樣對不起來。fileURLToPath 走的是正規的反向轉換。
 */
export function isDirectRun(
  entry: string | undefined,
  moduleUrl: string,
): boolean {
  if (entry === undefined) return false;
  try {
    // realpath 兩邊都解到底,symlink、相對路徑、大小寫差異一次抹平。
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // 任一邊指到不存在的東西(不該發生)—— 當成不是直接執行,寧可少跑也不誤跑。
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2), process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      err(`✗ unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = EXIT.UNKNOWN;
    });
}
