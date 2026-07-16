// 檔案落地 —— 解析要抓哪些檔、路徑防呆、寫進 extensions/<id>/。

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fetchText, type IndexEntry } from "./registry.js";
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
      throw new Error(`registry 提供了不安全的檔案路徑:${unsafe}`);
    }
    return { files: entry.files, heuristic: false };
  }

  const found: string[] = [];
  await Promise.all(
    HEURISTIC_FILENAMES.map(async (name) => {
      try {
        await fetchText(fileUrl(source, entry.id, name), token);
        found.push(name);
      } catch {
        // 猜測模式下,某檔不存在(404)不是錯誤 —— 略過。
      }
    }),
  );
  if (!found.includes("index.ts")) {
    throw new Error(
      `啟發式找不到 extensions/${entry.id}/files/index.ts —— ` +
        `如果你懷疑此 extension 有更多檔,請手動檢查 registry repo`,
    );
  }
  return { files: found.sort(), heuristic: true };
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
      throw new Error(`不安全的檔案路徑,拒絕寫入:${rel}`);
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
