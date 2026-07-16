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
  const dir = await mkdtemp(path.join(tmpdir(), "suko-reg-"));
  const filesDir = path.join(dir, "extensions", "demoext", "files");
  await mkdir(filesDir, { recursive: true });
  await writeFile(
    path.join(filesDir, "index.ts"),
    `export const demoext = defineExtension({ id: "demoext" });\n`,
  );
  await writeFile(path.join(filesDir, "provider.ts"), `export const p = 1;\n`);
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

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "suko-repo-"));
  await mkdir(path.join(dir, "extensions"), { recursive: true });
  await writeFile(path.join(dir, "extensions", "registry.ts"), emptyRegistry);
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
    const empty = await mkdtemp(path.join(tmpdir(), "suko-empty-"));
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
  it("still installs by probing common filenames", async () => {
    const { dir, url } = await makeRegistry(false);
    try {
      const code = await run(["add", "demoext", "--source", url], repoDir);
      expect(code).toBe(EXIT.OK);
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
});
