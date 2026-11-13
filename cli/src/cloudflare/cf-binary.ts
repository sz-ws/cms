// Finding cf, checking its version, and how to install it into a site project.

import { existsSync } from "node:fs";
import path from "node:path";
import type { Executor } from "../exec.js";
import type { InstallPlan, Readiness } from "./port.js";

/** npm package name of Cloudflare's CLI. */
export const CF_PACKAGE = "cf";

// cf is a beta: its commands are generated from Cloudflare's API description and
// their names and output change between releases. This CLI was tested against
// CF_TESTED. Older releases are refused (CF_VERSION_UNSUPPORTED); newer ones run
// with a warning, because refusing every new beta would break sites weekly.
export const CF_TESTED = "1.0.0-beta.32";
export const CF_MIN = "1.0.0-beta.32";

/**
 * For every package-manager child process: Corepack (which runs pnpm and yarn for
 * projects that pin "packageManager") would otherwise stop and ask before it
 * downloads the pinned version. The person already agreed to the install, and
 * without a terminal nobody could answer.
 */
export const PACKAGE_MANAGER_ENV: Readonly<Record<string, string>> = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/** cf declares Node 22 or newer. */
export const NODE_MIN_MAJOR = 22;

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parseVersion(text: string): string | null {
  const m = VERSION_RE.exec(text);
  return m ? m[0] : null;
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1; // a release sorts after its prereleases
  if (b === undefined) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const diff = Number.isNaN(na) || Number.isNaN(nb) ? pa[i].localeCompare(pb[i]) : na - nb;
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Semver order, prerelease identifiers compared numerically where they are numbers. */
export function compareVersions(a: string, b: string): number {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePrerelease(ma[4], mb[4]);
}

export function nodeTooOld(nodeVersion: string): boolean {
  return Number(nodeVersion.replace(/^v/, "").split(".")[0]) < NODE_MIN_MAJOR;
}

async function versionOf(exec: Executor, cmd: string, cwd: string): Promise<string | null> {
  try {
    const r = await exec(cmd, ["--version"], { cwd });
    return r.code === 0 ? parseVersion(r.stdout) : null;
  } catch {
    return null; // ENOENT: not on PATH
  }
}

/** The site's own cf first (node_modules/.bin/cf), then cf on PATH. */
export async function findCf(
  exec: Executor,
  cwd: string,
  nodeVersion: string,
): Promise<Readiness> {
  if (nodeTooOld(nodeVersion)) return { state: "node-too-old", node: nodeVersion };
  const local = path.join(cwd, "node_modules", ".bin", "cf");
  for (const command of existsSync(local) ? [local, "cf"] : ["cf"]) {
    const version = await versionOf(exec, command, cwd);
    if (version === null) continue;
    if (compareVersions(version, CF_MIN) < 0) return { state: "unsupported", version, command };
    return { state: "ready", version, command, untested: compareVersions(version, CF_TESTED) > 0 };
  }
  return { state: "missing" };
}

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * Installs the tested release as a devDependency of the site project. Outside a
 * project (no package.json) the plan is a global install, which this CLI only
 * prints and never runs itself.
 */
export function installPlanFor(cwd: string): InstallPlan {
  const spec = `${CF_PACKAGE}@${CF_TESTED}`;
  if (!existsSync(path.join(cwd, "package.json"))) {
    return { display: `npm install -g ${spec}`, cmd: "npm", args: ["install", "-g", spec], env: PACKAGE_MANAGER_ENV };
  }
  const manager = detectPackageManager(cwd);
  const args =
    manager === "npm" ? ["install", "--save-dev", spec] : manager === "bun" ? ["add", "-d", spec] : ["add", "-D", spec];
  return { display: [manager, ...args].join(" "), cmd: manager, args, env: PACKAGE_MANAGER_ENV };
}
