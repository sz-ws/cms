import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runCreate,
  nextSteps,
  DEFAULT_TEMPLATE,
  DIR_NAME_RE,
} from "./create.js";
import type { Executor, ExecResult } from "./exec.js";
import type { Reporter } from "./ui.js";

// 測試絕不呼叫真的 git —— 注入的 executor 記下每一次呼叫並回傳預設好的結果。
function recorder(results: Record<string, ExecResult> = {}) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const exec: Executor = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    const key = `${cmd} ${args[0] ?? ""}`;
    return results[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function reporter() {
  const steps: { status: string; message: string }[] = [];
  const r: Reporter = {
    intro: () => {},
    step: (status, message) => steps.push({ status, message }),
    note: () => {},
    outro: () => {},
    task: async (_label, fn) => fn(),
  };
  return { steps, reporter: r };
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "cms-create-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("DIR_NAME_RE", () => {
  it.each(["my-site", "acme-taipei", "a1", "x".repeat(48)])("接受 %s", (d) => {
    expect(DIR_NAME_RE.test(d)).toBe(true);
  });

  it.each(["A", "1site", "-lead", "has space", "x".repeat(49), "a", "..", "a_b"])(
    "拒絕 %s",
    (d) => {
      expect(DIR_NAME_RE.test(d)).toBe(false);
    },
  );
});

describe("runCreate", () => {
  it("預設 clone 內建模板,--depth 1", async () => {
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();

    const res = await runCreate({ dir: "my-site", cwd, exec, reporter: r });

    expect(res.ok).toBe(true);
    const clone = calls.find((c) => c.args[0] === "clone")!;
    expect(clone.cmd).toBe("git");
    expect(clone.args).toEqual([
      "clone",
      "--depth",
      "1",
      DEFAULT_TEMPLATE,
      "my-site",
    ]);
  });

  it("--template 覆寫來源 —— 別人可以指定自己的 fork", async () => {
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();
    const mine = "https://github.com/me/my-fork.git";

    await runCreate({ dir: "my-site", cwd, exec, reporter: r, template: mine });

    expect(calls.find((c) => c.args[0] === "clone")!.args).toContain(mine);
  });

  it("--ref 轉成 --branch", async () => {
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();

    await runCreate({ dir: "my-site", cwd, exec, reporter: r, ref: "v2" });

    const clone = calls.find((c) => c.args[0] === "clone")!;
    expect(clone.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "v2",
      DEFAULT_TEMPLATE,
      "my-site",
    ]);
  });

  it("clone 之後砍掉模板的 .git 並重新 init", async () => {
    // 假 executor 不會真的建目錄,所以這裡自己造一個帶 .git 的來驗刪除。
    const dest = path.join(cwd, "my-site");
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();
    const wrapped: Executor = async (cmd, args, opts) => {
      if (args[0] === "clone") await mkdir(path.join(dest, ".git"), { recursive: true });
      return exec(cmd, args, opts);
    };

    await runCreate({ dir: "my-site", cwd, exec: wrapped, reporter: r });

    // 不砍的話使用者的第一個 push 會打到模板 repo。
    expect(existsSync(path.join(dest, ".git"))).toBe(false);
    expect(calls.some((c) => c.args[0] === "init" && c.cwd === dest)).toBe(true);
  });

  it("--skip-git-init 保留模板的 .git,也不跑 git init", async () => {
    const dest = path.join(cwd, "my-site");
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();
    const wrapped: Executor = async (cmd, args, opts) => {
      if (args[0] === "clone") await mkdir(path.join(dest, ".git"), { recursive: true });
      return exec(cmd, args, opts);
    };

    await runCreate({ dir: "my-site", cwd, exec: wrapped, reporter: r, skipGitInit: true });

    expect(existsSync(path.join(dest, ".git"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "init")).toBe(false);
  });

  it("目標目錄非空就拒絕", async () => {
    await mkdir(path.join(cwd, "my-site"), { recursive: true });
    await writeFile(path.join(cwd, "my-site", "keep.txt"), "x");
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();

    const res = await runCreate({ dir: "my-site", cwd, exec, reporter: r });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("dest_exists");
    // 最重要的是:一個字都還沒動就停了。
    expect(calls).toHaveLength(0);
    expect(await readdir(path.join(cwd, "my-site"))).toEqual(["keep.txt"]);
  });

  it("目標目錄存在但為空 → 照樣進行", async () => {
    await mkdir(path.join(cwd, "my-site"), { recursive: true });
    const { exec } = recorder();
    const { reporter: r } = reporter();

    expect((await runCreate({ dir: "my-site", cwd, exec, reporter: r })).ok).toBe(true);
  });

  it("目錄名不合法就拒絕,且不呼叫 git", async () => {
    const { calls, exec } = recorder();
    const { reporter: r } = reporter();

    const res = await runCreate({ dir: "Bad Name", cwd, exec, reporter: r });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_dir");
    expect(calls).toHaveLength(0);
  });

  it("git 不在 PATH 上時,訊息要指向 git 而不是網路", async () => {
    const { exec } = recorder({ "git --version": { code: 127, stdout: "", stderr: "" } });
    const { reporter: r } = reporter();

    const res = await runCreate({ dir: "my-site", cwd, exec, reporter: r });

    expect(res.reason).toBe("git_missing");
    expect(res.message).toMatch(/git/i);
  });

  it("clone 失敗時把 git 的 stderr 原文帶出來", async () => {
    const { exec } = recorder({
      "git clone": { code: 128, stdout: "", stderr: "fatal: repository not found" },
    });
    const { reporter: r } = reporter();

    const res = await runCreate({
      dir: "my-site",
      cwd,
      exec,
      reporter: r,
      template: "https://github.com/nope/nope.git",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("clone_failed");
    // 使用者要看得到真正的原因,不是「exited 128」。
    expect(res.message).toContain("repository not found");
  });

  it("--dry-run 什麼都不送出、什麼都不建立", async () => {
    const { calls, exec } = recorder();
    const { steps, reporter: r } = reporter();

    const res = await runCreate({ dir: "my-site", cwd, exec, reporter: r, dryRun: true });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(cwd, "my-site"))).toBe(false);
    expect(steps.every((s) => s.status === "todo")).toBe(true);
  });
});

describe("nextSteps", () => {
  it("順序與 docs/deploy-playbook.md 一致,且 slug 沿用目錄名", () => {
    expect(nextSteps("acme")).toEqual([
      "cd acme",
      "pnpm install",
      "npx @sz.ws/cms setup --site-slug acme",
      "pnpm deploy",
    ]);
  });
});
