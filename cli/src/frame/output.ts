// Turning an Outcome or an error into output: the JSON envelope on stdout with
// --json, otherwise the result text on stdout and prose (warnings, errors) on
// stderr. Also maps Cloudflare failures onto the CLI's error codes.

import path from "node:path";
import { detectPackageManager } from "../cloudflare/cf-binary.js";
import { CloudflareError } from "../cloudflare/port.js";
import { isProgramMissing, type ProgramMissingError } from "../exec.js";
import type { StyleSet } from "../ui.js";
import type { Io, Outcome, Warning } from "./context.js";
import { CliError } from "./errors.js";
import { EXIT_CODE, type ExitCodeValue } from "./spec.js";

export interface Envelope {
  ok: boolean;
  command: string;
  data: unknown;
  plan: unknown[];
  warnings: Warning[];
  error: { code: string; message: string; hint?: string; next: readonly string[] } | null;
}

export function envelope(command: string, outcome: Outcome | undefined, warnings: Warning[], error?: CliError): Envelope {
  return {
    ok: error === undefined,
    command,
    data: outcome?.data ?? error?.data ?? null,
    plan: outcome?.plan ?? [],
    warnings,
    error: error
      ? { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), next: error.next }
      : null,
  };
}

/** The error as plain lines for stderr, in the shape of the approved mock-ups. */
export function errorLines(error: CliError, s: StyleSet): string[] {
  const head = error.code === "CANCELLED" ? `   ${error.message}` : `${s.red("✗")}  ${error.message}`;
  return [
    head,
    ...(error.hint ? [`   ${error.hint}`] : []),
    ...error.next.map((n) => `   ${s.dim("next:")} ${n}`),
  ];
}

export function warningLines(warnings: readonly Warning[], s: StyleSet): string[] {
  return warnings.map((w) => `${s.yellow("!")}  ${w.message}`);
}

export interface Emit {
  io: Io;
  json: boolean;
  command: string;
  err: StyleSet;
}

/** Print the result (or failure) and return the exit code. */
export function emit(o: Emit, outcome: Outcome | undefined, warnings: Warning[], error?: CliError): ExitCodeValue {
  const failure = error ?? outcome?.error;
  if (o.json) {
    o.io.out(`${JSON.stringify(envelope(o.command, outcome, warnings, failure), null, 2)}\n`);
  } else {
    if (outcome?.text) o.io.out(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
    const prose = [...warningLines(warnings, o.err), ...(failure ? errorLines(failure, o.err) : [])];
    if (prose.length > 0) o.io.err(`${outcome?.text ? "\n" : ""}${prose.join("\n")}\n`);
  }
  return failure?.exit ?? EXIT_CODE.OK;
}

const PERMISSIONS_HINT =
  "An API token needs read access to Workers Scripts, D1, Workers R2 Storage and Workers KV Storage on this account.";

/** Map a remote failure onto the CLI's error codes. `again` is the command to re-run. */
export function fromCloudflare(e: CloudflareError, again: string): CliError {
  switch (e.failure) {
    case "AUTH_REQUIRED":
      return new CliError({
        code: "AUTH_REQUIRED",
        message: "Not signed in to Cloudflare.",
        hint: "Run `cms login` in a terminal, or set CLOUDFLARE_API_TOKEN to an API token.",
        next: ["cms login"],
      });
    case "AUTH_INVALID":
      return new CliError({
        code: "AUTH_INVALID",
        message: `Cloudflare rejected the credentials: ${e.message}`,
        hint: "Sign in again with `cms login`, or check CLOUDFLARE_API_TOKEN.",
        next: ["cms login"],
      });
    case "PERMISSION_DENIED":
      return new CliError({ code: "PERMISSION_DENIED", message: `Permission denied: ${e.message}`, hint: PERMISSIONS_HINT, next: [again] });
    case "TRANSIENT":
      return new CliError({
        code: "TRANSIENT",
        message: `Cloudflare kept failing after retries: ${e.message}`,
        hint: "This is usually temporary. Running the command again is safe.",
        next: [again],
      });
    default:
      return new CliError({ code: "CF_FAILED", message: e.message, next: [again] });
  }
}

const PACKAGE_MANAGERS: Readonly<Record<string, string[]>> = {
  pnpm: ["corepack enable pnpm", "npm install -g pnpm"],
  yarn: ["corepack enable yarn", "npm install -g yarn"],
  bun: ["npm install -g bun"],
  npm: [],
};

/** A program that could not be started, with what to install. The one place ENOENT becomes words. */
export function fromMissingProgram(e: ProgramMissingError, again: string): CliError {
  const { program, command } = e;
  const binDir = path.dirname(command);
  if (path.basename(binDir) === ".bin" && path.basename(path.dirname(binDir)) === "node_modules") {
    const project = path.dirname(path.dirname(binDir));
    const manager = detectPackageManager(project);
    return new CliError({
      code: "DEPENDENCIES_MISSING",
      message: `The project's ${program} is not installed (${path.relative(project, command)} is missing).`,
      hint: "Install the project's dependencies, then run the command again.",
      next: [manager === "npm" ? "npm ci" : `${manager} install`, again],
    });
  }
  if (program in PACKAGE_MANAGERS) {
    return new CliError({
      code: "PACKAGE_MANAGER_MISSING",
      message: program === "npm" ? "npm is not installed; it comes with Node.js." : `${program} is not installed; this project uses it (its lockfile says so).`,
      hint: program === "npm" ? "Install Node.js 22 or newer." : `Install ${program}, then run the command again.`,
      next: [...PACKAGE_MANAGERS[program], again],
    });
  }
  if (program === "git") {
    return new CliError({ code: "GIT_MISSING", message: "git is not installed or not on PATH.", hint: "Install git, then run the command again.", next: [again] });
  }
  return new CliError({ code: "PROGRAM_MISSING", message: `${program} is not installed or not on PATH.`, hint: `Install ${program}, then run the command again.`, next: [again] });
}

/** Anything thrown by a command, as a CliError. */
export function toCliError(e: unknown, again: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof CloudflareError) return fromCloudflare(e, again);
  if (isProgramMissing(e)) return fromMissingProgram(e, again);
  return new CliError({ code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e), exit: EXIT_CODE.FAILED });
}
