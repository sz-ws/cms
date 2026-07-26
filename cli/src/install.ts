// 檔案落地 —— 解析要抓哪些檔、路徑防呆、寫進 extensions/<id>/。

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fetchText, RegistryFetchError, type IndexEntry } from "./registry.js";
import { camelCaseId } from "./patch.js";

// registry index 無 files[] 時的啟發式檔名清單(spec §registry schema 配合:
// 短期接受「猜檔名」的不完美)。index.ts 為必要入口。
export const HEURISTIC_FILENAMES = [
  "index.ts",
  "index.tsx",
  "provider.ts",
  "adapter.ts",
  "admin-page.tsx",
  "crypto.ts",
  "types.ts",
  "config.ts",
  "handler.ts",
  "style.css",
  "manifest.json",
  "README.md",
];

/** 拒絕 path traversal / 絕對路徑的 rel;只允許 extensions/<id>/ 內的相對子路徑。 */
export function isSafeRelPath(rel: string): boolean {
  if (rel.length === 0) return false;
  if (path.isAbsolute(rel)) return false;
  const normalized = path.normalize(rel);
  if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
    return false;
  }
  return true;
}

function fileUrl(source: string, id: string, rel: string): string {
  return `${source}/extensions/${id}/files/${rel}`;
}

export interface ResolveResult {
  /** 要安裝的相對路徑清單。 */
  files: string[];
  /** true 若清單來自啟發式猜測(非 registry 權威 files[])。 */
  heuristic: boolean;
}

/**
 * 決定要抓哪些檔:
 *   - entry.files 存在 → 權威,直接用。
 *   - 否則 → 啟發式:逐一 probe HEURISTIC_FILENAMES,存在者納入。index.ts 必要。
 */
export async function resolveFiles(
  source: string,
  entry: IndexEntry,
  token: string | undefined,
): Promise<ResolveResult> {
  if (entry.files && entry.files.length > 0) {
    const unsafe = entry.files.find((f) => !isSafeRelPath(f));
    if (unsafe) {
      throw new Error(`registry provided unsafe file path: ${unsafe}`);
    }
    return { files: entry.files, heuristic: false };
  }

  const found: string[] = [];
  const probeErrors: string[] = [];
  await Promise.all(
    HEURISTIC_FILENAMES.map(async (name) => {
      try {
        await fetchText(fileUrl(source, entry.id, name), token);
        found.push(name);
      } catch (e) {
        // 與 spec 失敗模式表(「抓檔途中某檔 404 → 中止 exit 2」)刻意不同:probe 階段的
        // 404 就是「這個猜的檔名不存在」,是正常結果,不該中止。
        // 但**只有 404** 能當成不存在 —— 逾時 / 網路錯誤 / 401 / size cap 若也被吞掉,
        // 結果是靜默少抓檔:人類看到「✓ 裝好了」,拿到的卻是殘缺 extension。那些往上丟,
        // 由呼叫端 exit 2。
        if (e instanceof RegistryFetchError && e.status === 404) return;
        probeErrors.push(
          `${name}:${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  );
  if (probeErrors.length > 0) {
    throw new Error(
      `probing extensions/${entry.id}/files/ found fetch failures other than 404, cannot determine file list` +
        ` (continuing would silently fetch incomplete files): ${probeErrors.join(";")}`,
    );
  }
  if (!found.includes("index.ts")) {
    throw new Error(
      `heuristic probe could not find extensions/${entry.id}/files/index.ts —` +
        ` if you suspect this extension has more files, manually check the registry repo`,
    );
  }
  return { files: found.sort(), heuristic: true };
}

/**
 * 啟發式模式要對使用者講清楚的話。
 * HEURISTIC_FILENAMES 是**扁平檔名**清單,probe 不會走進子目錄 —— 例如 cron extension
 * 的 worker/(三個檔)在這個模式下永遠抓不到,而且因為 404 被當成「不存在」,整個過程
 * 一個錯誤都不會出現。使用者必須知道手上這份可能是殘缺安裝,而不是以為 CLI 抓全了。
 */
export function heuristicWarnings(id: string, files: string[]): string[] {
  return [
    "⚠ registry index entry has no files[], using heuristic name guessing — list may be incomplete.",
    `  guessed ${files.length} files: ${files.join(", ")}`,
    "  probe only tries fixed flat filenames, **does not recurse into subdirectories** (e.g., cron worker/ not fetched).",
    `  compare against registry's actual extensions/${id}/files/ contents; manually add missing files,` +
      " and ask registry maintainer to add files[] to this entry.",
  ];
}

export interface FetchedFile {
  rel: string;
  content: string;
}

/**
 * 逐檔抓取並(非 dry-run 時)寫入 destDir。回傳已抓內容(供驗證 index.ts export)。
 * 某檔抓取失敗會 throw —— 呼叫端 exit 2,已寫的檔保留(部分安裝狀態人類看得懂)。
 */
export async function fetchAndWriteFiles(opts: {
  source: string;
  entry: IndexEntry;
  token: string | undefined;
  files: string[];
  destDir: string;
  dryRun: boolean;
}): Promise<FetchedFile[]> {
  const { source, entry, token, files, destDir, dryRun } = opts;
  const written: FetchedFile[] = [];
  for (const rel of files) {
    if (!isSafeRelPath(rel)) {
      throw new Error(`unsafe file path, refusing to write: ${rel}`);
    }
    const content = await fetchText(fileUrl(source, entry.id, rel), token);
    if (!dryRun) {
      const dest = path.join(destDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    written.push({ rel, content });
  }
  return written;
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * 驗證下載的 index.ts 帶有名為 camelCase(id) 的 named export。
 * (registry.ts 的 import 會用這個名字;缺 → 無法接線。)
 */
export function hasNamedExport(indexSource: string, id: string): boolean {
  const ident = camelCaseId(id);
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(
    `export\\s+(?:const|let|var|function|class)\\s+${escaped}\\b`,
  );
  if (declRe.test(indexSource)) return true;
  // 亦接受 `export { ..., ident, ... }` 形式。
  const namedRe = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  return namedRe.test(indexSource);
}
