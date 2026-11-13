// The project's own tools: its package manager, OpenNext and wrangler. Build and
// upload stay with them because they are tied to the project's build. Wrangler's
// results are read from the NDJSON records it appends to WRANGLER_OUTPUT_FILE_PATH
// (OpenNext passes the environment through), not from its text output.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { detectPackageManager } from "../../cloudflare/cf-binary.js";
import { firstJsonValue } from "../../cloudflare/cf-output.js";
import type { Executor, ExecResult } from "../../exec.js";
import type { DeployLog } from "./steps.js";

export interface Project {
  dir: string;
  configPath: string;
  accountId: string;
  exec: Executor;
  log: DeployLog;
}

export const SPLIT_SCRIPT = path.join("scripts", "split-server-chunks.mjs");

export function bin(dir: string, name: string): string {
  return path.join(dir, "node_modules", ".bin", name);
}

export function hasWrangler(dir: string): boolean {
  return existsSync(bin(dir, "wrangler"));
}

/** Run a project command; output goes to the log, failure throws with the last useful line. */
async function run(p: Project, cmd: string, args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  const result = await p.exec(cmd, args, { cwd: p.dir, env: { CLOUDFLARE_ACCOUNT_ID: p.accountId, ...env } });
  await p.log.command(cmd, args, result);
  if (result.code !== 0) {
    const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines.find((l) => /error|failed|✘/i.test(l)) ?? lines[lines.length - 1];
    throw new Error(last ?? `${path.basename(cmd)} exited with code ${result.code}`);
  }
  return result;
}

export function installCommand(dir: string): { cmd: string; args: string[] } {
  const manager = detectPackageManager(dir);
  return manager === "npm" ? { cmd: "npm", args: ["ci"] } : { cmd: manager, args: ["install", "--frozen-lockfile"] };
}

export async function installDependencies(p: Project): Promise<void> {
  const { cmd, args } = installCommand(p.dir);
  await run(p, cmd, args);
}

/** wrangler's own login: build and upload go through it. */
export async function wranglerSignedIn(exec: Executor, dir: string): Promise<boolean> {
  const r = await exec(bin(dir, "wrangler"), ["whoami", "--json"], { cwd: dir });
  const value = firstJsonValue(r.stdout) as { loggedIn?: unknown } | undefined;
  return r.code === 0 && value?.loggedIn === true;
}

export async function wranglerLogin(exec: Executor, dir: string): Promise<boolean> {
  return (await exec(bin(dir, "wrangler"), ["login"], { cwd: dir, inheritStdio: true })).code === 0;
}

/** OpenNext build, then the split step for sites that opted into the split server entry. */
export async function build(p: Project, nodePath: string): Promise<void> {
  await run(p, bin(p.dir, "opennextjs-cloudflare"), ["build", "--config", p.configPath]);
  if (existsSync(path.join(p.dir, SPLIT_SCRIPT))) {
    await run(p, nodePath, [SPLIT_SCRIPT, "--config", p.configPath]);
  }
}

export interface WranglerRecord {
  type: string;
  version_id?: string;
  targets?: string[];
  message?: string;
}

async function withRecords(p: Project, fn: (env: Record<string, string>) => Promise<unknown>): Promise<WranglerRecord[]> {
  const file = `${p.log.file}.wrangler.ndjson`;
  await rm(file, { force: true });
  let failure: unknown;
  await fn({ WRANGLER_OUTPUT_FILE_PATH: file }).catch((e: unknown) => {
    failure = e;
  });
  const text = await readFile(file, "utf8").catch(() => "");
  const records = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as WranglerRecord);
  const failed = records.find((r) => r.type === "command-failed");
  if (failure !== undefined || failed) throw new Error(failed?.message ?? (failure instanceof Error ? failure.message : String(failure)));
  return records;
}

/** Upload a new version that does not take traffic. Returns its id. */
export async function uploadVersion(p: Project): Promise<string> {
  const records = await withRecords(p, (env) => run(p, bin(p.dir, "opennextjs-cloudflare"), ["upload", "--config", p.configPath], env));
  const id = records.find((r) => r.type === "version-upload")?.version_id;
  if (!id) throw new Error("wrangler did not report the uploaded version id");
  return id;
}

/** First deploy of a Worker that does not exist yet. Returns the version id and the URLs. */
export async function deployWorker(p: Project): Promise<{ versionId?: string; targets: string[] }> {
  const records = await withRecords(p, (env) => run(p, bin(p.dir, "opennextjs-cloudflare"), ["deploy", "--config", p.configPath], env));
  const deployed = records.find((r) => r.type === "deploy");
  if (!deployed) throw new Error("wrangler did not report a deployment");
  return { versionId: deployed.version_id, targets: deployed.targets ?? [] };
}

/** Migrations through wrangler, which owns the d1_migrations bookkeeping; success is its exit code. */
export async function applyMigrations(p: Project, databaseName: string): Promise<void> {
  await run(p, bin(p.dir, "wrangler"), ["d1", "migrations", "apply", databaseName, "--remote", "--config", p.configPath]);
}
