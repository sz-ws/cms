import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isSafeRelPath,
  hasNamedExport,
  resolveFiles,
  fetchAndWriteFiles,
  heuristicWarnings,
} from "./install.js";
import type { IndexEntry } from "./registry.js";

describe("isSafeRelPath", () => {
  it("accepts nested relative paths", () => {
    expect(isSafeRelPath("index.ts")).toBe(true);
    expect(isSafeRelPath("worker/index.js")).toBe(true);
  });
  it("rejects traversal / absolute", () => {
    expect(isSafeRelPath("../secret")).toBe(false);
    expect(isSafeRelPath("a/../../b")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
  });
});

describe("hasNamedExport", () => {
  it("finds `export const <ident>`", () => {
    expect(hasNamedExport(`export const newebpay = defineExtension({`, "newebpay")).toBe(true);
    expect(hasNamedExport(`export const aiSmokeTest = x;`, "ai-smoke-test")).toBe(true);
  });
  it("finds `export { ident }`", () => {
    expect(hasNamedExport(`const cron = 1;\nexport { cron };`, "cron")).toBe(true);
  });
  it("returns false when absent", () => {
    expect(hasNamedExport(`export const other = 1;`, "cron")).toBe(false);
  });
});

// ---- file:// registry fixtures ----
async function makeRegistry(): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "szws-reg-"));
  const filesDir = path.join(dir, "extensions", "demoext", "files");
  await mkdir(path.join(filesDir, "worker"), { recursive: true });
  await writeFile(
    path.join(filesDir, "index.ts"),
    `export const demoext = defineExtension({ id: "demoext" });\n`,
  );
  await writeFile(path.join(filesDir, "provider.ts"), `export const p = 1;\n`);
  await writeFile(path.join(filesDir, "worker", "index.js"), `// worker\n`);
  return { dir, url: pathToFileURL(dir).href };
}

let regDir: string;
let regUrl: string;
let workDir: string;

beforeEach(async () => {
  const r = await makeRegistry();
  regDir = r.dir;
  regUrl = r.url;
  workDir = await mkdtemp(path.join(tmpdir(), "szws-work-"));
});
afterEach(async () => {
  await rm(regDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

const codeEntry = (files?: string[]): IndexEntry => ({
  id: "demoext",
  kind: "code",
  name: "Demo",
  version: "1.0.0",
  coreApi: "^1.0.0",
  files,
  source: regUrl,
});

describe("resolveFiles", () => {
  it("uses authoritative files[] when present", async () => {
    const r = await resolveFiles(regUrl, codeEntry(["index.ts", "worker/index.js"]), undefined);
    expect(r.heuristic).toBe(false);
    expect(r.files).toEqual(["index.ts", "worker/index.js"]);
  });

  it("falls back to heuristic probing", async () => {
    const r = await resolveFiles(regUrl, codeEntry(), undefined);
    expect(r.heuristic).toBe(true);
    expect(r.files).toContain("index.ts");
    expect(r.files).toContain("provider.ts");
    expect(r.files).not.toContain("adapter.ts"); // absent in fixture
  });

  it("啟發式抓不到子目錄(已知缺口,靠警告告知使用者)", async () => {
    const r = await resolveFiles(regUrl, codeEntry(), undefined);
    // fixture 有 worker/index.js,但扁平檔名 probe 看不到它 —— 這正是 cron 少三個檔的成因。
    expect(r.files).not.toContain("worker/index.js");
    const warnings = heuristicWarnings("cron", r.files).join("\n");
    expect(warnings).toContain("does not recurse into subdirectories");
    expect(warnings).toContain("files[]");
  });

  it("probe 遇到非 404 的錯誤時中止(不靜默少抓檔)", async () => {
    // 用目錄冒充 adapter.ts:讀它會得到 EISDIR(不是 404)—— 代表「這檔可能存在但讀不到」。
    // 舊行為會把它跟 404 一起吞掉,結果安裝少一個檔卻毫無徵兆。
    await mkdir(path.join(regDir, "extensions", "demoext", "files", "adapter.ts"));
    await expect(resolveFiles(regUrl, codeEntry(), undefined)).rejects.toThrow(
      /other than 404/,
    );
  });

  it("rejects unsafe paths in files[]", async () => {
    await expect(
      resolveFiles(regUrl, codeEntry(["../../../etc/passwd"]), undefined),
    ).rejects.toThrow(/unsafe file path/);
  });
});

describe("fetchAndWriteFiles", () => {
  it("writes files preserving subdirs", async () => {
    const destDir = path.join(workDir, "extensions", "demoext");
    const written = await fetchAndWriteFiles({
      source: regUrl,
      entry: codeEntry(),
      token: undefined,
      files: ["index.ts", "worker/index.js"],
      destDir,
      dryRun: false,
    });
    expect(written.length).toBe(2);
    const w = await readFile(path.join(destDir, "worker", "index.js"), "utf8");
    expect(w).toContain("worker");
  });

  it("dry-run writes nothing", async () => {
    const destDir = path.join(workDir, "extensions", "demoext");
    await fetchAndWriteFiles({
      source: regUrl,
      entry: codeEntry(),
      token: undefined,
      files: ["index.ts"],
      destDir,
      dryRun: true,
    });
    await expect(readFile(path.join(destDir, "index.ts"))).rejects.toThrow();
  });

  it("throws (partial kept) when a declared file 404s", async () => {
    const destDir = path.join(workDir, "extensions", "demoext");
    await expect(
      fetchAndWriteFiles({
        source: regUrl,
        entry: codeEntry(),
        token: undefined,
        files: ["index.ts", "does-not-exist.ts"],
        destDir,
        dryRun: false,
      }),
    ).rejects.toThrow();
    // index.ts 已寫入(部分安裝保留)。
    const kept = await readFile(path.join(destDir, "index.ts"), "utf8");
    expect(kept).toContain("demoext");
  });
});
