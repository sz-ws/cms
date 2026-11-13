// `cms upgrade`: read-only for now, because how a site takes a new core is not
// decided yet. It compares the site's core with the newest core of the template
// (its newest release tag, or the default branch), read from a shallow clone in a
// temporary folder that is removed afterwards, and counts the migrations the
// newer core adds. No file of the site changes.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareVersions } from "../cloudflare/cf-binary.js";
import { readCoreApiVersion } from "../coreapi.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { plural } from "./format.js";
import { newestReleaseTag } from "./init.js";

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".sql")).sort();
}

async function newestRef(ctx: Ctx, template: string): Promise<string | undefined> {
  const r = await ctx.exec("git", ["ls-remote", "--tags", "--refs", template], { cwd: ctx.cwd });
  if (r.code !== 0) throw new CliError({ code: "CLONE_FAILED", message: `Could not read ${template}: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? `git exited ${r.code}`}`, next: [`cms upgrade --template <url>`] });
  return newestReleaseTag(r.stdout);
}

export async function runUpgrade(ctx: Ctx): Promise<Outcome> {
  const template = String(ctx.values.template);
  const current = await readCoreApiVersion(ctx.cwd);
  const ref = await newestRef(ctx, template);
  if (!ref) ctx.warn("NO_RELEASE_TAG", `${template} has no release tag; comparing with its default branch.`);
  const temp = await mkdtemp(path.join(tmpdir(), "cms-upgrade-"));
  try {
    const clone = await ctx.progress("Reading the template", () =>
      ctx.exec("git", ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--quiet", template, path.join(temp, "core")], { cwd: temp }),
    );
    if (clone.code !== 0) throw new CliError({ code: "CLONE_FAILED", message: `git clone of ${template} failed: ${clone.stderr.trim().split("\n").pop() ?? ""}`, next: ["cms upgrade"] });
    const latest = await readCoreApiVersion(path.join(temp, "core"));
    const theirs = await sqlFiles(path.join(temp, "core", "migrations"));
    const ours = new Set(await sqlFiles(path.join(ctx.cwd, "migrations")));
    const newMigrations = theirs.filter((f) => !ours.has(f));
    const behind = current && latest ? compareVersions(current, latest) < 0 : null;
    const data = { core: current, template, ref: ref ?? null, latest, behind, newMigrations, changed: false };
    const text = [
      `Core of this site   ${current ?? "unknown"}`,
      `Newest core         ${latest ?? "unknown"} (${ref ? `release ${ref}` : "default branch"} of ${template})`,
      behind === null ? "Could not compare the two versions." : behind ? "This site is behind." : "This site is up to date.",
      `${plural(newMigrations.length, "database migration")} in the newer core that this site does not have${newMigrations.length > 0 ? `: ${newMigrations.join(", ")}` : ""}.`,
      "",
      "Nothing was changed: cms upgrade only reports for now.",
    ].join("\n");
    return { data, text };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
