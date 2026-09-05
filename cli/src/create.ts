// `cms create <dir>` —— 把 CMS 模板取到本機,這是整條流程的第一步。
//
// 在此之前 CLI 沒有這個指令,使用者得自己知道 repo 網址、自己 clone、自己記得
// 把 .git 砍掉。那是「開始使用」路上最不該有的一道門檻。
//
// ## 為什麼是 git clone 而不是下載 tarball
//
// 零依賴是這支 CLI 的硬條件(`npx @sz.ws/cms` 要免安裝)。git 一定在(沒有 git
// 就不會有人在部署 Workers),而 tarball 要嘛拉 degit 這種依賴,要嘛自己寫解壓。
// `--depth 1` 讓它跟下載一樣快。
//
// ## 為什麼一定要換掉 .git
//
// clone 下來的 .git 帶著模板的完整歷史與 remote。不處理的話使用者的第一個
// `git push` 會打到 sz-ws/cms —— 對沒有權限的人是一個看不懂的錯誤,對有權限的
// 人是把自己的站推進模板。所以砍掉重建,讓新專案的第一個 commit 就是他自己的。
//
// ## 來源網址只有一個地方寫死
//
// cms repo 之後可能搬家。`DEFAULT_TEMPLATE` 是唯一的字面值,其餘一律經過參數,
// 而且 `--template` / `SZWS_CMS_TEMPLATE` 都能覆寫,不必等發版。

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Executor } from "./exec.js";
import type { Reporter } from "./ui.js";

/** 唯一寫死的來源。搬家時只改這裡,並記得同步 docs/deploy-playbook.md。 */
export const DEFAULT_TEMPLATE = "https://github.com/sz-ws/cms.git";

/** 目錄名沿用 site slug 的字元集,兩者常常會是同一個字。 */
export const DIR_NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;

export interface CreateOptions {
  /** 目標目錄名(相對 cwd)。 */
  dir: string;
  cwd: string;
  exec: Executor;
  reporter: Reporter;
  /** 覆寫模板來源;預設 DEFAULT_TEMPLATE。 */
  template?: string;
  /** 只印計畫,不建立任何東西、不送出任何指令。 */
  dryRun?: boolean;
  /** 指定分支 / tag / 任意 ref;不給就用來源的預設分支。 */
  ref?: string;
  /** 略過 `git init` —— 給「clone 進既有 monorepo」這種場景。 */
  skipGitInit?: boolean;
}

export interface CreateResult {
  ok: boolean;
  /** 失敗原因;呼叫端據此挑 exit code。 */
  reason?: "invalid_dir" | "dest_exists" | "git_missing" | "clone_failed";
  /** 建立出來的絕對路徑(dry-run 下也會給,方便印下一步)。 */
  dest?: string;
  message?: string;
}

/** 目標目錄可用 = 不存在,或存在但完全是空的。 */
async function destUsable(dest: string): Promise<boolean> {
  if (!existsSync(dest)) return true;
  try {
    return (await readdir(dest)).length === 0;
  } catch {
    return false;
  }
}

export async function runCreate(o: CreateOptions): Promise<CreateResult> {
  const { reporter: r } = o;
  const template = o.template ?? DEFAULT_TEMPLATE;

  if (!DIR_NAME_RE.test(o.dir)) {
    return {
      ok: false,
      reason: "invalid_dir",
      message:
        `invalid directory name "${o.dir}" — use 2–48 chars: lowercase letters, ` +
        `digits and hyphens, starting with a letter`,
    };
  }

  // path.resolve 之後再比一次前綴:`--dir ../../etc` 之類的相對路徑不該逃出 cwd。
  const dest = path.resolve(o.cwd, o.dir);
  if (path.dirname(dest) !== path.resolve(o.cwd)) {
    return {
      ok: false,
      reason: "invalid_dir",
      message: `refusing to create outside the current directory: ${dest}`,
    };
  }

  if (!(await destUsable(dest))) {
    return {
      ok: false,
      reason: "dest_exists",
      dest,
      message: `${o.dir}/ already exists and is not empty`,
    };
  }

  if (o.dryRun) {
    r.step("todo", `would clone ${template}${o.ref ? ` @ ${o.ref}` : ""}`, dest);
    if (!o.skipGitInit) {
      r.step("todo", "would reset git history", "remove .git, then `git init`");
    }
    return { ok: true, dest };
  }

  // git 不在的話,錯誤訊息要講得比 "ENOENT" 有用。
  const probe = await o.exec("git", ["--version"], { cwd: o.cwd });
  if (probe.code !== 0) {
    return {
      ok: false,
      reason: "git_missing",
      message: "git is required but was not found on PATH",
    };
  }

  const clone = await r.task(`cloning ${template}${o.ref ? ` @ ${o.ref}` : ""}`, () =>
    o.exec(
      "git",
      [
        "clone",
        "--depth",
        "1",
        ...(o.ref ? ["--branch", o.ref] : []),
        template,
        o.dir,
      ],
      { cwd: o.cwd },
    ),
  );
  if (clone.code !== 0) {
    return {
      ok: false,
      reason: "clone_failed",
      dest,
      // git 把進度寫 stderr,所以失敗原因在那裡。
      message: clone.stderr.trim() || `git clone exited ${clone.code}`,
    };
  }

  if (!o.skipGitInit) {
    // 砍掉模板歷史與 remote。失敗不算致命 —— 程式碼已經在了,只是使用者得自己
    // 處理 remote;比讓整個 create 失敗、留下一個半好的目錄要好。
    try {
      await rm(path.join(dest, ".git"), { recursive: true, force: true });
      const init = await o.exec("git", ["init"], { cwd: dest });
      if (init.code !== 0) {
        r.step(
          "warn",
          "template history removed, but `git init` failed",
          `run it yourself in ${o.dir}/`,
        );
      }
    } catch (e) {
      r.step(
        "warn",
        `could not reset git history (${e instanceof Error ? e.message : String(e)})`,
        `remove ${o.dir}/.git before your first commit, or you'll push to the template repo`,
      );
    }
  }

  return { ok: true, dest };
}

/** 建立成功後印的下一步。順序就是 docs/deploy-playbook.md 的順序。 */
export function nextSteps(dir: string): string[] {
  return [
    `cd ${dir}`,
    `npx @sz.ws/cms deploy --site-slug ${dir}`,
  ];
}
