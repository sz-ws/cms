#!/usr/bin/env node
// `suko add <id>` —— code-extension 安裝器。
// 自動化:讀 registry 索引 → 抓 extensions/<id>/files/* → 寫本機 extensions/<id>/
//        → patch extensions/registry.ts。DB row / build / deploy 仍由人類做。

import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";
import { parseArgs, ID_RE } from "./args.js";
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
} from "./install.js";
import { patchRegistryContent, camelCaseId } from "./patch.js";

export const VERSION = "0.1.0";

// spec §結束狀態
export const EXIT = {
  OK: 0,
  NOT_FOUND: 1, // <id> 找不到 / 缺 id / path traversal / 多源衝突
  FETCH_FAILED: 2, // 網路 / 404 / size cap
  DEST_EXISTS: 3, // extensions/<id>/ 已存在且無 --force
  PATCH_FAILED: 4, // registry.ts patch 失敗
  UNKNOWN: 5,
} as const;

const USAGE = `用法:
  suko add <id> [--source <url>] [--token <t>] [--dry-run] [--force] [--non-interactive]

  <id>                安裝的 extension id(^[a-z][a-z0-9-]{1,30}$)
  --source <url>      registry base URL(預設 ${DEFAULT_SOURCE})
  --token <t>         registry 存取 token(private repo;亦讀 SUKO_REGISTRY_TOKEN)
  --dry-run           只印出將做的事,不寫磁碟 / 不改檔
  --force             覆寫已存在的 extensions/<id>/
  --non-interactive   不互動(隱含 --force);多源 / 格式衝突仍中止
  --help, --version`;

function log(msg = ""): void {
  process.stdout.write(`${msg}\n`);
}
function err(msg: string): void {
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

function nextSteps(id: string, fileCount: number, patchNote: string): void {
  log();
  log(`✓ 複製了 ${fileCount} 個檔到 extensions/${id}/`);
  log(`✓ ${patchNote}`);
  log();
  log("接下來(CLI 不代跑):");
  log("  1. 跑 migrations(若此 extension 需要):");
  log("       pnpm db:migrate:local    # 本機 D1");
  log("       pnpm db:migrate:remote   # 正式 D1");
  log("  2. 在 admin Installed 分頁為此 extension 啟用(INSERT extensions row)。");
  log("  3. pnpm build && wrangler deploy");
  log(`  4. cron / webhook 等需外部伴侶的 extension:見 extensions/${id}/worker/`);
  log("     或 manifest 附帶的部署說明。");
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
  if (args.command !== "add") {
    err(`✗ 未知指令:${args.command ?? "(無)"}`);
    err(USAGE);
    return EXIT.NOT_FOUND;
  }

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
        "請確認你在 CMS repo 根目錄執行 `suko add`。",
    );
    return EXIT.PATCH_FAILED;
  }

  // ---- sources ----
  const token = args.token ?? process.env.SUKO_REGISTRY_TOKEN;
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
        err("    suko add <id> --token <你的 token>");
        err("    或設環境變數 SUKO_REGISTRY_TOKEN=<你的 token>");
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
      "declarative 走 admin UI 的 Browse → Install 熱裝,不需要 `suko add`。",
    );
    return EXIT.OK;
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

  const ident = camelCaseId(id);

  if (args.dryRun) {
    log(`[dry-run] 將安裝 code extension「${id}」(${entry.name} v${entry.version})`);
    log(`[dry-run] 來源:${source}`);
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

  nextSteps(id, written.length, patchNote);
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
