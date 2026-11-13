// `cms init [dir]`: a new site project, cloned from the newest release tag of the
// template (or its default branch when it has none). `--deploy` continues with
// `cms deploy` in the new directory, whose name becomes the site name.
// `cms create` is the old name and runs this after a one-line notice.

import path from "node:path";
import { DIR_NAME_RE, runCreate } from "../create.js";
import type { Executor } from "../exec.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { createReporter } from "../ui.js";
import { runDeploy } from "./deploy/deploy.js";
import { againCommand } from "./connect.js";
import { askUntilValid, inputRequired } from "./deploy/inputs.js";
import { validateSiteName } from "../site/naming.js";

const TAG_RE = /^refs\/tags\/(v?(\d+)\.(\d+)\.(\d+))$/;

/** The newest x.y.z (or vx.y.z) tag, or undefined. Prereleases are skipped. */
export function newestReleaseTag(lsRemote: string): string | undefined {
  const tags = lsRemote
    .split("\n")
    .map((line) => TAG_RE.exec(line.split("\t")[1]?.trim() ?? ""))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ tag: m[1], parts: [Number(m[2]), Number(m[3]), Number(m[4])] }));
  tags.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return tags[0]?.tag;
}

async function releaseRef(ctx: Ctx, exec: Executor, template: string): Promise<string | undefined> {
  if (typeof ctx.values.ref === "string") return ctx.values.ref;
  const r = await exec("git", ["ls-remote", "--tags", "--refs", template], { cwd: ctx.cwd }).catch(() => null);
  const tag = r?.code === 0 ? newestReleaseTag(r.stdout) : undefined;
  if (!tag) ctx.warn("NO_RELEASE_TAG", `${template} has no release tag${r?.code === 0 ? "" : " that could be read"}; cloning its default branch.`);
  return tag;
}

/** Why `dir` cannot be used, or null. With --deploy the directory name is also the site name. */
function dirProblem(dir: string, deploy: boolean): string | null {
  if (!DIR_NAME_RE.test(dir)) return `"${dir}" cannot be a directory name here: 2-48 lowercase letters, digits and hyphens, starting with a letter.`;
  const name = deploy ? validateSiteName(dir) : null;
  return name ? `"${dir}" cannot be a site name, and --deploy names the site after the directory. ${name}` : null;
}

async function directory(ctx: Ctx): Promise<string> {
  const deploy = ctx.values.deploy === true;
  const given = ctx.positionals[0];
  if (given) {
    const problem = dirProblem(given, deploy);
    // A value on the command line fails at once, before anything is cloned.
    if (problem) throw new CliError({ code: "BAD_VALUE", message: problem, next: [deploy ? "cms init <another-dir> --deploy" : "cms init <another-dir>"] });
    return given;
  }
  if (!ctx.interactive) throw inputRequired([{ input: "directory", env: "(argument)", flag: "<dir>" }], againCommand(ctx));
  return askUntilValid(ctx, "Directory for the new site (e.g. acme)", (v) => dirProblem(v, deploy));
}

const CREATE_FAILURES: Record<string, string> = { dest_exists: "DEST_EXISTS", invalid_dir: "BAD_VALUE", git_missing: "GIT_MISSING", clone_failed: "CLONE_FAILED" };

export async function runInit(ctx: Ctx): Promise<Outcome> {
  if (ctx.spec.name === "create") ctx.warn("COMMAND_RENAMED", "`cms create` is now `cms init`.");
  const dir = await directory(ctx);
  const template = String(ctx.values.template);
  const ref = await releaseRef(ctx, ctx.exec, template);
  const reporter = createReporter({ write: ctx.io.err, animate: ctx.animate, styles: ctx.err });
  const dryRun = ctx.values["dry-run"] === true;
  const result = await runCreate({ dir, cwd: ctx.cwd, exec: ctx.exec, reporter, template, ref, dryRun, skipGitInit: ctx.values["skip-git-init"] === true });
  if (!result.ok) {
    throw new CliError({ code: CREATE_FAILURES[result.reason ?? ""] ?? "CLONE_FAILED", message: result.message ?? "Creating the project failed.", next: ["cms init <another-dir>"] });
  }
  const data = { dir, template, ref: ref ?? null, dryRun };
  if (ctx.values.deploy === true && !dryRun) {
    const dest = result.dest ?? path.resolve(ctx.cwd, dir);
    // Running init again would stop at the existing directory; the re-run is deploy there.
    const again = ["-C", path.relative(ctx.cwd, dest) || ".", "deploy", ...ctx.argv.filter((a) => a === "--yes" || a === "-y" || a === "--json")];
    const site = ctx.inDir(dest, again);
    const deployed = await runDeploy({ ...site, values: { ...site.values, name: site.values.name ?? dir } });
    for (const w of site.warnings) ctx.warn(w.code, w.message);
    return { ...deployed, data: { init: data, deploy: deployed.data } };
  }
  return { data, text: [`Created ${dir}/${ref ? ` from ${ref}` : ""}.`, `Next: cd ${dir} && cms deploy`].join("\n") };
}
