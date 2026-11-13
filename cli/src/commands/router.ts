// Entry for the table commands, help and unknown commands. Returns undefined when
// the arguments belong to a 0.x command, which cli.ts then runs as before.

import { createCfPort } from "../cloudflare/cf-port.js";
import { spawnExecutor } from "../exec.js";
import { createContext, type Ctx, type Deps, type Io, type Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { helpJson, renderCommandHelp, renderGlobalHelp } from "../frame/help.js";
import { emit, toCliError } from "../frame/output.js";
import { parseCommand, resolveCommand } from "../frame/parse.js";
import { COMMANDS, findCommand } from "../frame/commands.js";
import { EXIT_CODE, type CommandSpec } from "../frame/spec.js";
import { makeStyles } from "../ui.js";
import { againCommand } from "./connect.js";
import { runDoctor } from "./doctor.js";
import { runLoginCommand } from "./login.js";
import { runLogs } from "./logs.js";
import { runStatus } from "./status.js";
import { runVersionList } from "./versions.js";
import { runDeploy } from "./deploy/deploy.js";
import { runInit } from "./init.js";
import { runPreflightCommand, runSecretsCommand } from "./kept.js";

type Handler = (ctx: Ctx) => Promise<Outcome | undefined>;

const HANDLERS: Record<string, Handler> = {
  status: runStatus,
  doctor: runDoctor,
  login: runLoginCommand,
  "version list": runVersionList,
  logs: runLogs,
  deploy: runDeploy,
  init: runInit,
  create: runInit,
  secrets: runSecretsCommand,
  preflight: runPreflightCommand,
};

function moved(io: Io, spec: CommandSpec, json: boolean): number {
  const error = new CliError({
    code: "COMMAND_MOVED",
    message: `\`cms ${spec.name}\` is now part of \`cms deploy\`.`,
    hint: "See what it would do with --dry-run; it asks before changing anything.",
    next: [...(spec.movedTo ?? [])],
  });
  return emit({ io, json, command: spec.name, err: makeStyles(false) }, undefined, [], error);
}

export function processIo(): Io {
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
    stderrTty: process.stderr.isTTY === true,
    env: process.env,
    nodeVersion: process.version,
    now: () => new Date(),
  };
}

export function defaultDeps(): Deps {
  return {
    io: processIo(),
    exec: spawnExecutor,
    cloudflare: (cwd) => createCfPort({ exec: spawnExecutor, cwd, nodeVersion: process.version }),
  };
}

function helpCommand(io: Io, version: string, words: readonly string[], json: boolean): number {
  const name = words.join(" ");
  const spec = name ? findCommand(name) : undefined;
  if (name && !spec) {
    const error = new CliError({ code: "UNKNOWN_COMMAND", message: `No command "${name}".`, next: ["cms help"] });
    return emit({ io, json, command: "help", err: makeStyles(false) }, undefined, [], error);
  }
  if (json) io.out(`${JSON.stringify(helpJson(version, spec), null, 2)}\n`);
  else io.out(`${spec ? renderCommandHelp(spec) : renderGlobalHelp(version)}\n`);
  return EXIT_CODE.OK;
}

function unknownCommand(io: Io, input: string, suggestion: string | undefined, json: boolean): number {
  const error = new CliError({
    code: "UNKNOWN_COMMAND",
    message: `Unknown command "${input}".`,
    hint: suggestion ? `Did you mean \`cms ${suggestion}\`?` : `Commands: ${COMMANDS.map((c) => c.name).join(", ")}.`,
    next: suggestion ? [`cms ${suggestion}`, "cms help"] : ["cms help"],
  });
  return emit({ io, json, command: input, err: makeStyles(false) }, undefined, [], error);
}

async function runTable(spec: CommandSpec, rest: string[], cwd: string, deps: Deps, version: string, argv: readonly string[]): Promise<number> {
  const { io } = deps;
  const json = rest.includes("--json");
  if (spec.movedTo && !rest.some((a) => WANTS_HELP.has(a))) return moved(io, spec, json);
  let parsed;
  try {
    parsed = parseCommand(spec, rest, io.env);
  } catch (e) {
    return emit({ io, json, command: spec.name, err: makeStyles(false) }, undefined, [], toCliError(e, `cms help ${spec.name}`));
  }
  if (spec.name === "help") return helpCommand(io, version, parsed.positionals, parsed.values.json === true);
  if (parsed.values.help === true) return helpCommand(io, version, [spec.name], parsed.values.json === true);
  const ctx = createContext(deps, parsed, cwd, argv);
  const target = { io, json: ctx.json, command: spec.name, err: ctx.err };
  try {
    const outcome = await HANDLERS[spec.name](ctx);
    return outcome === undefined ? EXIT_CODE.OK : emit(target, outcome, ctx.warnings);
  } catch (e) {
    return emit(target, undefined, ctx.warnings, toCliError(e, againCommand(ctx)));
  }
}

const WANTS_HELP = new Set(["--help", "-h"]);
const WANTS_VERSION = new Set(["--version", "-v"]);

/**
 * Handles the table commands, `help`, `--help`, a bare `cms` and unknown
 * commands. Returns undefined for the 0.x commands and for `cms version` /
 * `--version`, which cli.ts keeps handling.
 */
export async function runNew(argv: readonly string[], cwd: string, version: string, deps: Deps = defaultDeps()): Promise<number | undefined> {
  const r = resolveCommand(argv);
  const json = argv.includes("--json");
  if (r.kind === "none") {
    if (argv.some((a) => WANTS_VERSION.has(a))) return undefined;
    return helpCommand(deps.io, version, [], json);
  }
  if (r.kind === "unknown") {
    if (r.input === "version") return undefined;
    return unknownCommand(deps.io, r.input, r.suggestion, json);
  }
  if (r.spec.parser === "legacy") {
    if (r.rest.some((a) => WANTS_HELP.has(a))) return helpCommand(deps.io, version, [r.spec.name], json);
    if (r.spec.aliasOf) deps.io.err(`\`cms ${r.spec.name}\` is now \`cms ${r.spec.aliasOf}\`.\n`);
    return undefined;
  }
  return runTable(r.spec, r.rest, cwd, deps, version, argv);
}
