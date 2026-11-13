#!/usr/bin/env node
// sz-ws-cms —— sz.ws CMS 的命令列工具。
//
// 指令表(frame/commands.ts)上的指令由 commands/router.ts 處理:一張表驅動解析、
// 說明與 `help --json`,JSON 信封與固定的結束代碼。這個檔只剩外掛安裝器:
//
//   plugin add <id>   讀 registry 索引 → 抓 extensions/<id>/files/* → 寫本機
//   (舊名 add)       extensions/<id>/ → patch extensions/registry.ts → 問設定。
//
// 安裝器的參數解析(args.ts)、輸出與結束代碼(exit.ts)維持 0.x 的樣子。

import { readFile, writeFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as readline from "node:readline/promises";
import { parseArgs, ID_RE, type ParsedArgs } from "./args.js";
import {
  DEFAULT_SOURCE,
  fetchIndex,
  isNotEntitled,
  type IndexEntry,
  VERSION_RE,
  type SourceConfig,
} from "./registry.js";
import { sanitizeRegistryText } from "./registry-text.js";
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
import { configureExtension } from "./configure.js";
import { createUi, type UiEvent } from "./ui.js";
import { runNew } from "./commands/router.js";
import { findCommand } from "./frame/commands.js";
import { renderGlobalHelp } from "./frame/help.js";
import { nearest } from "./frame/suggest.js";

// 版號住在 version.ts(指令也要用,避免與 cli.ts 循環引用);這裡 re-export,既有契約不變。
export { VERSION } from "./version.js";
import { VERSION } from "./version.js";

// 結束狀態碼定義搬到 exit.ts(setup.ts 也要用,避免循環相依);
// 這裡 re-export,`import { EXIT } from "./cli.js"` 的既有契約不變。
export { EXIT } from "./exit.js";

export const DEFAULT_CONFIG_FILE = "wrangler.jsonc";

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
  enhancement = false,
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
  if (enhancement) {
    // 強化層沒有自己的 Enable / migrations —— 那些屬於宣告式那一半,而它是在後台
    // 熱安裝的。這裡唯一要做的事就是 deploy,之後被標記的 surface 會換成自訂元件。
    log("next steps (not automated by this CLI):");
    log("  1. pnpm build && pnpm run deploy       # overrides register at module load, so a deploy is what lights them up");
    log(`  2. install "${id}" itself in admin → Extensions → Browse (if you have not already)`);
    log("     (the declarative half hot-installs and works on its own; this layer only upgrades its views)");
    return;
  }
  log("next steps (not automated by this CLI):");
  log("  1. pnpm build && pnpm run deploy       # Enable reads compile-time registry, must deploy first");
  log("  2. admin → Extensions → Installed → Enable");
  log("     (extension-specific migrations run here as a single D1 batch)");
  log("  3. for external integrations (like cron): see that extension's deployment guide.");
}

export async function run(argv: string[], cwd: string): Promise<number> {
  // 新骨架先看:表上的新指令、help、未知指令由它處理;回 undefined 才是 0.x 指令。
  const routed = await runNew(argv, cwd, VERSION);
  if (routed !== undefined) return routed;
  // `plugin add <id>` 與舊名 `add <id>` 走同一個安裝器;args.ts 認的是後者。
  const pluginAt = argv.indexOf("plugin");
  const args = parseArgs(pluginAt >= 0 && argv[pluginAt + 1] === "add" ? argv.filter((_, i) => i !== pluginAt) : argv);

  // --version / --help 是「被問就答」,答案本身就是結果 —— 這兩個照樣走 stdout,
  // 否則 `cms version` 沒辦法被 shell 取值,那是這類指令唯一的用途。
  if (args.version) {
    process.stdout.write(`@sz.ws/cms v${VERSION}\n`);
    return EXIT.OK;
  }
  if (args.help) {
    process.stdout.write(`${renderGlobalHelp(VERSION)}\n`);
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

/**
 * 走 Reporter 的流程(setup / preflight / add 的設定問答)收集到的事件。
 * 事件比純文字精確,--json 時一併吐出去。
 */
let setupEvents: UiEvent[] | null = null;

async function dispatch(args: ParsedArgs, cwd: string): Promise<number> {
  if (args.error) {
    // 不再整頁倒出說明:指出錯在哪、最接近的旗標,和去哪裡看完整用法。結束代碼維持 0.x 的 1。
    err(`✗ ${args.error}`);
    const hint = legacyFlagHint(args.command, args.error);
    if (hint) err(`  ${hint}`);
    err(`  run \`cms help${args.command ? ` ${args.command}` : ""}\` for the flags.`);
    return EXIT.NOT_FOUND;
  }
  if (args.command !== "add") {
    // 走不到:未知指令已由 runNew 以結束代碼 2 回報。留著是為了型別上的完整。
    err(`✗ unknown command: ${args.command ?? "(none)"}`);
    return EXIT.NOT_FOUND;
  }
  return runAdd(args, cwd);
}


/** 0.x 指令打錯旗標時,從指令表找最接近的那一個。 */
function legacyFlagHint(command: string | undefined, error: string): string | undefined {
  const flag = /unknown flag: (--[\w-]+)/.exec(error)?.[1];
  const spec = command ? findCommand(command) : undefined;
  if (!flag || !spec) return undefined;
  const suggestion = nearest(flag, spec.flags.map((f) => `--${f.name}`));
  return suggestion ? `did you mean ${suggestion}?` : undefined;
}

/**
 * 付費插件:這把 registry 金鑰沒開通這個插件(索引的 access 不是 granted,或抓檔回 402)。
 * 一行固定訊息 + 提供者寫的 message(已消毒、≤ 200 字)+ 去哪裡處理。
 */
function notEntitled(id: string, source: string, detail?: string): number {
  err(`✗ "${id}" is not activated for this registry key (${source}).`);
  if (detail) err(`  ${detail}`);
  err("  the provider has to activate it for your key first; the site's admin Store shows the price and how to reach them.");
  return EXIT.NOT_ENTITLED;
}

async function runAdd(args: ParsedArgs, cwd: string): Promise<number> {
  // `add <id>@<version>`:registry 為舊核心保留的版本。
  const [id, requestedVersion] = (args.id ?? "").split("@", 2) as [string, string | undefined];
  if (requestedVersion !== undefined && !VERSION_RE.test(requestedVersion)) {
    err(`✗ invalid version: "${requestedVersion}" must look like 1.2.3.`);
    return EXIT.NOT_FOUND;
  }
  if (!id) {
    err("✗ missing <id>");
    err("  usage: cms plugin add <id>[@<version>] [flags]   (cms help plugin add)");
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
        " — make sure you are running `cms plugin add` from the CMS repo root.",
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
        err("    cms plugin add <id> --token <your-token>");
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
      const ids = [...new Set(entries.map((e) => sanitizeRegistryText(e.id, 64)))].sort();
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

  let entry: IndexEntry = matches[0];
  const source = entry.source;
  if (requestedVersion !== undefined && requestedVersion !== entry.version) {
    const ref = entry.versions?.find((v) => v.version === requestedVersion);
    if (!ref) {
      const available = [entry.version, ...(entry.versions ?? []).map((v) => v.version)];
      err(`✗ "${id}" has no version ${requestedVersion} in the registry. available: ${available.join(", ")}`);
      return EXIT.NOT_FOUND;
    }
    entry = { ...entry, version: ref.version, coreApi: ref.coreApi, files: ref.files, archivedVersion: ref.version };
  }

  // 付費插件:索引說這把金鑰沒開通(locked / requested / expired)→ 不去抓檔、不猜檔名。
  if (entry.access !== undefined && entry.access !== "granted") {
    return notEntitled(id, source);
  }

  // 宣告式 extension 本體一律走 admin UI 熱安裝 —— 這支 CLI 不碰它。
  //
  // 但 CORE_API 1.25.0 起,宣告式 manifest 可以宣告 files[]:一層**選配**的程式碼
  // 強化層(core-v2 §3.6)。那一層是真的要落地成檔案 + 進 bundle 的,所以這裡分兩路:
  //
  //   沒有 files[] → 沒東西可裝,照舊指路到後台。
  //   有 files[]   → 抓下強化層,但接法是 side-effect import(它不是 Extension)。
  //
  // 先後順序仍然是:先在後台把宣告式那一半裝起來(立刻可用、泛用版面),再跑這個
  // 指令 + rebuild 把強化層點亮。反過來做也不會壞,只是在 enable 之前看不到效果。
  const isEnhancement = entry.kind !== "code";
  if (isEnhancement && (entry.files ?? []).length === 0) {
    log(`"${id}" is a declarative extension (kind=${entry.kind}).`);
    log(
      "declarative extensions are hot-installed via admin UI (Browse → Install), `cms plugin add` not needed.",
    );
    return EXIT.OK;
  }

  // ---- coreApi 相容性 ----
  // 沒有這關的話,不相容的 extension 會一路裝完 → rebuild → deploy,直到 admin 按
  // Enable 那刻才被 src/ext/manager.ts 的 enableExtension() 丟 CoreApiIncompatible。
  // 失敗點離錯誤來源太遠,所以提前到安裝當下。
  const localCore = await readCoreApiVersion(cwd);
  const verdict = checkCoreApi(localCore, entry.coreApi);
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
      const older =
        requestedVersion === undefined
          ? entry.versions?.find((v) => checkCoreApi(localCore, v.coreApi).status === "ok")
          : undefined;
      if (older) {
        err(`  the registry kept a version that works on this core:`);
        err(`    cms plugin add ${id}@${older.version}`);
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
    if (isNotEntitled(e)) return notEntitled(id, source, e.detail);
    err(`✗ could not determine which files to fetch: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.FETCH_FAILED;
  }

  if (resolved.heuristic) {
    for (const line of heuristicWarnings(id, resolved.files)) warn(line);
  }

  const ident = camelCaseId(id);

  if (args.dryRun) {
    log(
      isEnhancement
        ? `[dry-run] will install the code layer of declarative extension "${id}" (${entry.name} v${entry.version})`
        : `[dry-run] will install code extension "${id}" (${entry.name} v${entry.version})`,
    );
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
    // 和正式執行同一個 mode:強化層只加 side-effect import,不進 registry 陣列。
    const patch = patchRegistryContent(original, id, isEnhancement ? "enhancement" : "extension");
    if (!patch.ok) {
      log(`[dry-run] registry.ts patch would fail (${patch.reason}), manual insertion needed:`);
      log(`             ${patch.importLine}`);
      if (!isEnhancement) log(`             add to registry array: ${patch.ident}`);
    } else if (patch.alreadyUpToDate) {
      log("[dry-run] registry.ts already contains this extension (idempotent, no changes).");
    } else {
      log("[dry-run] will patch extensions/registry.ts:");
      if (patch.importAdded) {
        log(isEnhancement ? `             + import "./${id}";` : `             + import { ${ident} } from "./${id}";`);
      }
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
    if (isNotEntitled(e)) return notEntitled(id, source, e.detail);
    err(
      `✗ failed to fetch files: ${e instanceof Error ? e.message : String(e)}`,
    );
    err(
      "  partially written files remain (partial install). check if this extension is complete in the registry.",
    );
    return EXIT.FETCH_FAILED;
  }

  // ---- 驗證 index.ts named export ----
  // 只對 code extension 有意義:registry 陣列要拿到那個具名 export。強化層剛好相反
  // —— 它**刻意**沒有 export,整包的作用就是 module load 時的 side effect(把自訂
  // 元件登記進 overrides registry)。對它要求具名 export 會把正確的東西擋下來。
  const indexFile = written.find((f) => f.rel === "index.ts");
  if (!isEnhancement && (!indexFile || !hasNamedExport(indexFile.content, id))) {
    err(
      `✗ extensions/${id}/index.ts missing named export "${ident}", cannot wire up.`,
    );
    err(
      `  registry.ts needs \`import { ${ident} } from "./${id}"\`; verify this extension's index.ts.`,
    );
    return EXIT.PATCH_FAILED;
  }
  // 強化層仍然必須有 index.ts —— side-effect import 指的就是它,沒有這個檔,
  // 那行 import 會在 build 期解析失敗。
  if (isEnhancement && !indexFile) {
    err(`✗ extensions/${id}/index.ts not found; an enhancement layer needs one.`);
    err(`  registry.ts will \`import "./${id}"\`, which resolves to that file.`);
    return EXIT.PATCH_FAILED;
  }

  // ---- patch registry.ts ----
  const original = await readFile(registryPath, "utf8");
  const patch = patchRegistryContent(
    original,
    id,
    isEnhancement ? "enhancement" : "extension",
  );
  if (!patch.ok) {
    err("✗ could not automatically patch extensions/registry.ts (format not recognized).");
    if (isEnhancement) {
      err("  manual insertion needed (side-effect import only — an enhancement layer is not an Extension):");
      err(`    ${patch.importLine}`);
    } else {
      err("  manual insertion needed in two places:");
      err(`    ${patch.importLine}`);
      err(`    add to end of registry array: ${patch.ident}`);
    }
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

  // ---- 設定問答 ----
  // 在 nextSteps 之前:那段的最後一句是「去 admin 按 Enable」,問答排在它後面
  // 會讀起來像是 deploy 之後才要做的事,而 vars 必須在 deploy **之前**就寫好。
  await runConfigure(args, cwd, id);

  nextSteps(id, written.length, patchNote, resolved.heuristic, isEnhancement);
  return EXIT.OK;
}

/**
 * 裝完之後問一輪 manifest 的 settings[]。
 *
 * 失敗一律不影響 `add` 的結果:檔案已經落地、registry.ts 已經接好,那才是這個
 * 指令的契約。設定沒填完的話 `cms doctor` / `cms deploy` 會再擋一次,不需要在這裡把
 * 一次成功的安裝翻成失敗。
 */
async function runConfigure(args: ParsedArgs, cwd: string, id: string): Promise<void> {
  const assumeYes = args.yes || args.nonInteractive;
  const interactive = !assumeYes && process.stdin.isTTY === true;
  const ui = createUi({ interactive, json: args.json });
  // add 的 transcript 只收 log()/warn() 那幾行,設定問答走的是 Reporter ——
  // 不接上來的話 `add --json` 會看不到剛剛問了什麼、寫了哪些 key。
  if (ui.events) setupEvents = ui.events;
  try {
    await configureExtension({
      extensionsDir: path.join(cwd, "extensions"),
      configPath: args.config
        ? path.resolve(cwd, args.config)
        : path.join(cwd, DEFAULT_CONFIG_FILE),
      devVarsPath: path.join(cwd, ".dev.vars"),
      extId: id,
      reporter: ui.reporter,
      prompter: ui.prompter,
      interactive,
    });
  } catch (e) {
    warn(`⚠ settings step failed: ${e instanceof Error ? e.message : String(e)}`);
    warn("  the extension itself is installed; run `cms doctor` to see what is still unset.");
  }
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
