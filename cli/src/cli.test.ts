import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, EXIT } from "./cli.js";

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

const out = () => logSpy.mock.calls.map((c) => String(c[0])).join("");
const errOut = () => errSpy.mock.calls.map((c) => String(c[0])).join("");

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
    expect(out()).toContain("已是最新");
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
    expect(errOut()).toMatch(/無效/);
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
      expect(errOut()).toContain("啟發式");
      expect(errOut()).toContain("不會進子目錄");
      expect(out()).toContain("可能不完整");
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
    expect(out()).toContain("coreApi 相容");
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
  it("--help prints usage", async () => {
    const code = await run(["--help"], repoDir);
    expect(code).toBe(EXIT.OK);
    expect(out()).toContain("用法");
  });
  it("--help 同時涵蓋 add 與 setup", async () => {
    await run(["--help"], repoDir);
    expect(out()).toContain("sz-cms add <id>");
    expect(out()).toContain("sz-cms setup");
    expect(out()).toContain("--skip-migrations");
  });
});

describe("run — 指令派送", () => {
  it("未知指令仍是 exit 1", async () => {
    expect(await run(["frobnicate"], repoDir)).toBe(EXIT.NOT_FOUND);
    expect(errOut()).toContain("未知指令");
  });

  it("setup 走 setup 流程 —— 沒有 wrangler 設定檔就 exit 7", async () => {
    // repoDir 是個沒有 wrangler.jsonc 的臨時目錄,所以會停在前置檢查,
    // 一次 wrangler 都不會被叫到(絕不能真的去動 Cloudflare 帳號)。
    const code = await run(["setup"], repoDir);
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out()).toContain("讀不到 wrangler.jsonc");
  });

  it("setup --config 指到不存在的檔一樣是 exit 7", async () => {
    const code = await run(["setup", "--config", "nope.jsonc"], repoDir);
    expect(code).toBe(EXIT.SETUP_PREREQ);
    expect(out()).toContain("nope.jsonc");
  });
});
