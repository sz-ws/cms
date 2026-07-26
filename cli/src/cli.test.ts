import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, EXIT, isDirectRun } from "./cli.js";

const REGISTRY_HEADER = `import type { Extension } from "@/ext/types";\n`;
const emptyRegistry =
  REGISTRY_HEADER + `export const registry: Extension[] = [];\n`;

// ---- fixtures ----
async function makeRegistry(withFiles: boolean): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "szws-reg-"));
  const filesDir = path.join(dir, "extensions", "demoext", "files");
  await mkdir(filesDir, { recursive: true });
  await writeFile(
    path.join(filesDir, "index.ts"),
    `export const demoext = defineExtension({ id: "demoext" });\n`,
  );
  await writeFile(path.join(filesDir, "provider.ts"), `export const p = 1;\n`);
  const futureDir = path.join(dir, "extensions", "futureext", "files");
  await mkdir(futureDir, { recursive: true });
  await writeFile(
    path.join(futureDir, "index.ts"),
    `export const futureext = defineExtension({ id: "futureext" });\n`,
  );
  const registryJson = {
    extensions: [
      {
        id: "demoext",
        kind: "code",
        name: "Demo",
        version: "1.0.0",
        coreApi: "^1.0.0",
        ...(withFiles ? { files: ["index.ts", "provider.ts"] } : {}),
      },
      {
        // 需要比本機 core 新的 major → 安裝當下就該擋。
        id: "futureext",
        kind: "code",
        name: "From the future",
        version: "2.0.0",
        coreApi: "^99.0.0",
        files: ["index.ts"],
      },
      {
        // range 形式連 core 的 semver 都解析不了(">" 不支援)→ fail closed。
        id: "weirdext",
        kind: "code",
        name: "Weird range",
        version: "1.0.0",
        coreApi: ">1.0.0",
        files: ["index.ts"],
      },
      {
        id: "declme",
        kind: "declarative",
        name: "Decl",
        version: "1.0.0",
        coreApi: "^1.0.0",
      },
    ],
  };
  await writeFile(
    path.join(dir, "registry.json"),
    JSON.stringify(registryJson, null, 2),
  );
  return { dir, url: pathToFileURL(dir).href };
}

async function makeRepo(withCoreVersion = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "szws-repo-"));
  await mkdir(path.join(dir, "extensions"), { recursive: true });
  await writeFile(path.join(dir, "extensions", "registry.ts"), emptyRegistry);
  if (withCoreVersion) {
    await mkdir(path.join(dir, "src", "ext"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "ext", "version.ts"),
      `export const CORE_API_VERSION = "1.18.0";\n`,
    );
  }
  return dir;
}

let regDir: string;
let regUrl: string;
let repoDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const r = await makeRegistry(true);
  regDir = r.dir;
  regUrl = r.url;
  repoDir = await makeRepo();
  logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(regDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

// 人看的輸出現在全部走 stderr(stdout 只留給 --version / --help / --json 的結果)。
// out() 因此看 stderr —— 既有的斷言問的是「有沒有講這件事」,那個意圖沒有變。
// 真的要斷言 stdout 的測試改用 stdoutOut()。
const out = () => errSpy.mock.calls.map((c) => String(c[0])).join("");
const errOut = () => errSpy.mock.calls.map((c) => String(c[0])).join("");
const stdoutOut = () => logSpy.mock.calls.map((c) => String(c[0])).join("");

describe("run — full install path", () => {
  it("installs files and patches registry.ts", async () => {
    const code = await run(["add", "demoext", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.OK);
    const idx = await readFile(
      path.join(repoDir, "extensions", "demoext", "index.ts"),
      "utf8",
    );
    expect(idx).toContain("demoext");
    const reg = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    expect(reg).toContain(`import { demoext } from "./demoext";`);
    expect(reg).toContain(`[demoext]`);
  });
});

describe("run — dry-run", () => {
  it("writes nothing and leaves registry.ts unchanged", async () => {
    const before = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    const code = await run(
      ["add", "demoext", "--source", regUrl, "--dry-run"],
      repoDir,
    );
    expect(code).toBe(EXIT.OK);
    expect(out()).toContain("[dry-run]");
    const after = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    expect(after).toBe(before);
    await expect(
      readFile(path.join(repoDir, "extensions", "demoext", "index.ts")),
    ).rejects.toThrow();
  });
});

describe("run — dest exists (exit 3) and --force idempotent", () => {
  it("exits 3 when dir exists non-interactively", async () => {
    await run(["add", "demoext", "--source", regUrl], repoDir);
    // second run, dir + registry entry now exist, no --force
    const code = await run(["add", "demoext", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.DEST_EXISTS);
  });

  it("--force re-installs and registry patch is idempotent", async () => {
    await run(["add", "demoext", "--source", regUrl], repoDir);
    const regAfterFirst = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    const code = await run(
      ["add", "demoext", "--source", regUrl, "--force"],
      repoDir,
    );
    expect(code).toBe(EXIT.OK);
    const regAfterForce = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    // idempotent:registry.ts 不再變動,且無重複 import。
    expect(regAfterForce).toBe(regAfterFirst);
    expect(regAfterForce.match(/import \{ demoext \}/g)?.length).toBe(1);
    expect(out()).toContain("up to date");
  });
});

describe("run — error paths", () => {
  it("exit 1 when id not in registry", async () => {
    const code = await run(["add", "nope", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.NOT_FOUND);
  });

  it("exit 1 on invalid id (traversal)", async () => {
    const code = await run(["add", "../etc", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(errOut()).toMatch(/invalid extension id/);
  });

  it("exit 4 when not in a CMS repo (no registry.ts)", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "szws-empty-"));
    try {
      const code = await run(["add", "demoext", "--source", regUrl], empty);
      expect(code).toBe(EXIT.PATCH_FAILED);
      expect(errOut()).toContain("registry.ts");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("declarative id → exit 0 with admin-UI hint", async () => {
    const code = await run(["add", "declme", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.OK);
    expect(out()).toContain("declarative");
  });

  it("exit 2 when source registry.json is unreachable", async () => {
    const bogus = pathToFileURL(path.join(tmpdir(), "no-such-reg-dir")).href;
    const code = await run(["add", "demoext", "--source", bogus], repoDir);
    expect(code).toBe(EXIT.FETCH_FAILED);
  });

  it("exit 4 when registry.ts format is unrecognizable", async () => {
    await writeFile(
      path.join(repoDir, "extensions", "registry.ts"),
      `import { cron } from "./cron";\n// no registry array here\n`,
    );
    const code = await run(["add", "demoext", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.PATCH_FAILED);
    expect(errOut()).toContain("import { demoext }");
  });
});

describe("run — heuristic file resolution (no files[] in index)", () => {
  it("still installs by probing common filenames — 但要大聲警告清單是猜的", async () => {
    const { dir, url } = await makeRegistry(false);
    try {
      const code = await run(["add", "demoext", "--source", url], repoDir);
      expect(code).toBe(EXIT.OK);
      expect(errOut()).toContain("heuristic name guessing");
      expect(errOut()).toContain("does not recurse into subdirectories");
      expect(out()).toContain("may be incomplete");
      const idx = await readFile(
        path.join(repoDir, "extensions", "demoext", "index.ts"),
        "utf8",
      );
      expect(idx).toContain("demoext");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run — coreApi 相容性", () => {
  it("不相容 → exit 6,且沒有落地任何檔案", async () => {
    const code = await run(["add", "futureext", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.CORE_INCOMPATIBLE);
    expect(errOut()).toContain("^99.0.0");
    expect(errOut()).toContain("1.18.0");
    expect(errOut()).toContain("--skip-core-check");
    await expect(
      readFile(path.join(repoDir, "extensions", "futureext", "index.ts")),
    ).rejects.toThrow();
    // registry.ts 也不能被動到。
    const reg = await readFile(
      path.join(repoDir, "extensions", "registry.ts"),
      "utf8",
    );
    expect(reg).toBe(emptyRegistry);
  });

  it("dry-run 也擋(不相容就是不相容)", async () => {
    const code = await run(
      ["add", "futureext", "--source", regUrl, "--dry-run"],
      repoDir,
    );
    expect(code).toBe(EXIT.CORE_INCOMPATIBLE);
  });

  it("range 形式看不懂 → exit 6,訊息說明支援哪些形式", async () => {
    const code = await run(["add", "weirdext", "--source", regUrl], repoDir);
    expect(code).toBe(EXIT.CORE_INCOMPATIBLE);
    expect(errOut()).toContain("^1.2.3");
  });

  it("--skip-core-check → 照裝,但警告", async () => {
    const code = await run(
      ["add", "futureext", "--source", regUrl, "--skip-core-check"],
      repoDir,
    );
    expect(code).toBe(EXIT.OK);
    expect(errOut()).toContain("--skip-core-check");
    const idx = await readFile(
      path.join(repoDir, "extensions", "futureext", "index.ts"),
      "utf8",
    );
    expect(idx).toContain("futureext");
  });

  it("相容 → 正常安裝,dry-run 會印出判定結果", async () => {
    const code = await run(
      ["add", "demoext", "--source", regUrl, "--dry-run"],
      repoDir,
    );
    expect(code).toBe(EXIT.OK);
    expect(out()).toContain("coreApi compatible");
  });

  it("讀不到本機 core 版號 → 只警告,不擋", async () => {
    const noCore = await makeRepo(false);
    try {
      const code = await run(["add", "demoext", "--source", regUrl], noCore);
      expect(code).toBe(EXIT.OK);
      expect(errOut()).toContain("src/ext/version.ts");
    } finally {
      await rm(noCore, { recursive: true, force: true });
    }
  });
});

describe("run — help / version", () => {
  it("--version prints version", async () => {
    const code = await run(["--version"], repoDir);
    expect(code).toBe(EXIT.OK);
  });
  // help / version 走 **stdout**:被問就答,答案本身就是結果。
  // `cms version` 若寫 stderr,shell 就取不到值 —— 那是這類指令唯一的用途。
  it("--help prints usage", async () => {
    const code = await run(["--help"], repoDir);
    expect(code).toBe(EXIT.OK);
    expect(stdoutOut()).toContain("Usage:");
    expect(out()).toBe("");
  });
  it("--help 同時涵蓋 add 與 setup", async () => {
    await run(["--help"], repoDir);
    const help = stdoutOut();
    expect(help).toContain("cms add <id>");
    expect(help).toContain("cms setup");
    expect(help).toContain("--skip-migrations");
    expect(help).toContain("--json");
  });
  it("--version 走 stdout 且帶套件名", async () => {
    const code = await run(["--version"], repoDir);
    expect(code).toBe(EXIT.OK);
    expect(stdoutOut()).toContain("@sz.ws/cms v");
    expect(out()).toBe("");
  });
});

// --json 的重點不是「有沒有 JSON」,而是 stdout 有沒有被污染。只要有任何
// 一行進度訊息漏到 stdout,JSON.parse 就會炸 —— 這條測試就是那個守門。
describe("run — --json", () => {
  it("stdout 只有一份可解析的 JSON,進度全部在 stderr", async () => {
    const code = await run(["add", "demoext", "--source", regUrl, "--json"], repoDir);
    expect(code).toBe(EXIT.OK);

    const parsed = JSON.parse(stdoutOut());
    expect(parsed).toMatchObject({ ok: true, exitCode: EXIT.OK, command: "add", id: "demoext" });
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages.join("\n")).toContain("extensions/demoext/");

    // 人看的輸出仍然存在,只是不在 stdout。
    expect(out()).not.toBe("");
  });

  it("失敗時一樣是可解析的 JSON,且 ok=false", async () => {
    const code = await run(["add", "nope", "--source", regUrl, "--json"], repoDir);
    expect(code).not.toBe(EXIT.OK);
    const parsed = JSON.parse(stdoutOut());
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(code);
  });

  it("沒有 --json 時 stdout 完全乾淨", async () => {
    await run(["add", "demoext", "--source", regUrl], repoDir);
    expect(stdoutOut()).toBe("");
  });
});

describe("run — 指令派送", () => {
  it("未知指令仍是 exit 1", async () => {
    expect(await run(["frobnicate"], repoDir)).toBe(EXIT.NOT_FOUND);
    expect(errOut()).toContain("unknown command");
  });

  it("setup 走 setup 流程 —— 沒有 wrangler 設定檔就 exit 7", async () => {
    // repoDir 是個沒有 wrangler.jsonc 的臨時目錄,所以會停在前置檢查,
    // 一次 wrangler 都不會被叫到(絕不能真的去動 Cloudflare 帳號)。
    const code = await run(["setup"], repoDir);
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out()).toContain("wrangler.jsonc");
  });

  it("setup --config 指到不存在的檔一樣是 exit 7", async () => {
    const code = await run(["setup", "--config", "nope.jsonc"], repoDir);
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out()).toContain("nope.jsonc");
  });
});

// bin 入口偵測。0.2.0 發布出去是完全不能用的,原因就在這裡:當時比較的是
//   import.meta.url === `file://${process.argv[1]}`
// 而 npm 把 bin 連成 node_modules/.bin/cms → 真實檔案的 symlink,所以 argv[1]
// 是 symlink 路徑、import.meta.url 是 Node 解析後的真實路徑,兩者永遠不等。
// main 因此不跑,每個指令都靜默 exit 0 —— 本機 `node dist/cli.js` 測得到,
// 裝起來就死,而且死得像成功。
describe("isDirectRun", () => {
  it("symlink 指向本檔時算直接執行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "szws-bin-"));
    try {
      const real = path.join(dir, "cli.js");
      const link = path.join(dir, "cms");
      await writeFile(real, "// entry\n", "utf8");
      await symlink(real, link);

      const url = pathToFileURL(real).href;
      expect(isDirectRun(link, url)).toBe(true);
      expect(isDirectRun(real, url)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("路徑含空白或非 ASCII 時仍然算得對", async () => {
    // 舊寫法用字串樣板組 `file://${path}`,沒有 URL 編碼 —— 這種路徑同樣對不起來。
    const dir = await mkdtemp(path.join(tmpdir(), "szws bin 測試-"));
    try {
      const real = path.join(dir, "cli.js");
      await writeFile(real, "// entry\n", "utf8");
      expect(isDirectRun(real, pathToFileURL(real).href)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("被別的檔 import 時不算直接執行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "szws-bin-"));
    try {
      const me = path.join(dir, "cli.js");
      const other = path.join(dir, "other.js");
      await writeFile(me, "// entry\n", "utf8");
      await writeFile(other, "// importer\n", "utf8");
      expect(isDirectRun(other, pathToFileURL(me).href)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("argv[1] 不存在 / 指到不存在的檔 → false,而不是拋錯", () => {
    expect(isDirectRun(undefined, "file:///nope.js")).toBe(false);
    expect(isDirectRun("/definitely/not/here", "file:///nope.js")).toBe(false);
  });
});
