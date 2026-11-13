// What a table command gets to work with. Everything that touches the outside
// world (streams, env, child processes, Cloudflare, prompts) comes in through
// Deps, so tests run every command against fakes.

import path from "node:path";
import type { CloudflarePort } from "../cloudflare/port.js";
import type { Executor } from "../exec.js";
import { createReporter, makeStyles, type StyleSet } from "../ui.js";
import type { CliError } from "./errors.js";
import type { FlagValues } from "./parse.js";
import { createTtyPrompt, noPrompt, type Prompt } from "./prompt.js";
import type { CommandSpec } from "./spec.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdinTty: boolean;
  stdoutTty: boolean;
  stderrTty: boolean;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  now(): Date;
}

export interface Deps {
  io: Io;
  exec: Executor;
  /** Builds the Cloudflare port for a site directory. */
  cloudflare(cwd: string): CloudflarePort;
  /** Overrides the terminal prompt (tests). */
  prompt?: Prompt;
}

export interface Warning {
  code: string;
  message: string;
}

export interface PlanItem {
  action: string;
  type: string;
  name: string;
}

/** What a command hands back; the frame turns it into text or the JSON envelope. */
export interface Outcome {
  data: unknown;
  /** The human rendering of data, printed on stdout. */
  text?: string;
  plan?: PlanItem[];
  /** A failure that still carries data (e.g. doctor's failing checks). */
  error?: CliError;
}

export interface Ctx {
  spec: CommandSpec;
  values: FlagValues;
  /** Flags given on the command line (not filled from env or defaults). */
  explicit: ReadonlySet<string>;
  positionals: string[];
  passthrough: string[];
  /** The site directory (--dir, else the current directory). */
  cwd: string;
  json: boolean;
  /** True only when a person can answer: TTYs on both ends, no CI, no --json. */
  interactive: boolean;
  io: Io;
  exec: Executor;
  /** Styles for stdout and for stderr; each is plain when its stream is not a TTY. */
  out: StyleSet;
  err: StyleSet;
  prompt: Prompt;
  cloudflare(): CloudflarePort;
  warn(code: string, message: string): void;
  warnings: Warning[];
  /** A prose line on stderr (never in the JSON result). */
  say(line: string): void;
  /** Spinner on a TTY while fn runs; nothing otherwise. */
  progress<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

function colorAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR === undefined && env.TERM !== "dumb";
}

export function isInteractive(io: Io, json: boolean): boolean {
  return !json && !io.env.CI && io.stdinTty && io.stdoutTty;
}

export function createContext(
  deps: Deps,
  parsed: { spec: CommandSpec; values: FlagValues; explicit: ReadonlySet<string>; positionals: string[]; passthrough: string[] },
  baseDir: string,
): Ctx {
  const { io } = deps;
  const json = parsed.values.json === true;
  const interactive = isInteractive(io, json);
  const errStyles = makeStyles(colorAllowed(io.env) && io.stderrTty);
  const animate = io.stderrTty && !json;
  const reporter = createReporter({ write: io.err, animate, styles: errStyles });
  const dir = typeof parsed.values.dir === "string" ? path.resolve(baseDir, parsed.values.dir) : baseDir;
  let port: CloudflarePort | undefined;
  const warnings: Warning[] = [];
  return {
    ...parsed,
    cwd: dir,
    json,
    interactive,
    io,
    exec: deps.exec,
    out: makeStyles(colorAllowed(io.env) && io.stdoutTty && !json),
    err: errStyles,
    prompt: interactive ? (deps.prompt ?? createTtyPrompt(errStyles)) : noPrompt,
    cloudflare: () => (port ??= deps.cloudflare(dir)),
    warnings,
    warn: (code, message) => {
      if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message });
    },
    say: (line) => io.err(`${line}\n`),
    progress: (label, fn) => (animate ? reporter.task(label, fn) : fn()),
  };
}
