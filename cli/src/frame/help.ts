// Human help and `cms help --json`, both rendered from the command table.

import { COMMANDS, ENVIRONMENT, VERSION_COMMAND_NOTE } from "./commands.js";
import {
  AGENT_NOTE,
  ERROR_CODES,
  EXIT_CODE_MEANINGS,
  GLOBAL_FLAGS,
  type CommandSpec,
  type FlagSpec,
} from "./spec.js";

function pad(s: string, width: number): string {
  return s.length >= width ? `${s}  ` : s + " ".repeat(width - s.length);
}

export function usageOf(spec: CommandSpec): string {
  if (spec.usage) return spec.usage;
  const args = spec.positionals.map((p) => {
    const name = p.variadic ? `${p.name}...` : p.name;
    return p.required ? `<${name}>` : `[${name}]`;
  });
  return ["cms", spec.name, ...args, "[flags]"].join(" ");
}

function flagLabel(flag: FlagSpec): string {
  const long = `--${flag.name}${flag.type === "boolean" ? "" : ` <${flag.valueName ?? "value"}>`}`;
  return flag.short ? `-${flag.short}, ${long}` : `    ${long}`;
}

function flagLine(flag: FlagSpec): string {
  const extras = [
    flag.default !== undefined && flag.type !== "boolean" ? `default ${String(flag.default)}` : "",
    flag.env ? `env ${flag.env}` : "",
  ].filter(Boolean);
  const tail = extras.length > 0 ? ` (${extras.join("; ")})` : "";
  return `  ${pad(flagLabel(flag), 34)}${flag.summary}${tail}`;
}

const KEPT_NAMES = new Set(["create", "setup", "secrets", "preflight", "add"]);
const kept = (c: CommandSpec) => KEPT_NAMES.has(c.name);

/** `cms`, `cms help`, `cms --help`: one screen. */
export function renderGlobalHelp(version: string): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 4;
  const section = (title: string, specs: readonly CommandSpec[]) => [
    title,
    ...specs.map((c) => `  ${pad(`cms ${c.name}`, width + 4)}${c.summary}`),
    "",
  ];
  return [
    `@sz.ws/cms v${version} — sz.ws CMS command-line tool`,
    "",
    AGENT_NOTE,
    "",
    "Usage: cms <command> [flags]",
    "",
    ...section("Site", COMMANDS.filter((c) => c.parser === "table" && c.name !== "help" && !kept(c))),
    ...section("Plugins", COMMANDS.filter((c) => c.name.startsWith("plugin "))),
    ...section("Help", COMMANDS.filter((c) => c.name === "help")),
    ...section("0.x names, kept for one release", COMMANDS.filter(kept)),
    "Global flags (every command except plugin add)",
    ...GLOBAL_FLAGS.map(flagLine),
    "",
    "Environment",
    ...ENVIRONMENT.map((e) => `  ${e.name}\n      ${e.summary}`),
    "",
    VERSION_COMMAND_NOTE,
    "Run `cms help <command>` for its flags, examples and exit codes.",
    "docs: https://sz.ws",
  ].join("\n");
}

/** `cms help <command>` and `cms <command> --help`. */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines = [`${usageOf(spec)}`, "", spec.summary, ...(spec.notes ?? []), ""];
  if (spec.positionals.length > 0) {
    lines.push("Arguments", ...spec.positionals.map((p) => `  ${pad(p.name, 34)}${p.summary}`), "");
  }
  if (spec.flags.length > 0) lines.push("Flags", ...spec.flags.map(flagLine), "");
  if (spec.parser === "table") lines.push("Global flags", ...GLOBAL_FLAGS.map(flagLine), "");
  lines.push("Examples", ...spec.examples.map((e) => `  ${e}`), "");
  const exits = EXIT_CODE_MEANINGS.filter((e) => spec.exitCodes.includes(e.code));
  if (spec.parser === "table") {
    lines.push("Exit codes", ...exits.map((e) => `  ${pad(String(e.code), 6)}${e.meaning}`));
    if (spec.errorCodes.length > 0) lines.push("", `Error codes: ${spec.errorCodes.join(", ")}`);
  } else {
    lines.push(`Exit codes (0.x numbering): ${spec.exitCodes.join(", ")}`);
  }
  return lines.join("\n");
}

function flagJson(flag: FlagSpec) {
  return {
    name: `--${flag.name}`,
    ...(flag.short ? { short: `-${flag.short}` } : {}),
    type: flag.type,
    ...(flag.default !== undefined ? { default: flag.default } : {}),
    ...(flag.env ? { env: flag.env } : {}),
    ...(flag.secret ? { secret: true } : {}),
    ...(flag.choices ? { choices: flag.choices } : {}),
    summary: flag.summary,
  };
}

function commandJson(spec: CommandSpec) {
  return {
    name: spec.name,
    usage: usageOf(spec),
    summary: spec.summary,
    ...(spec.notes ? { notes: spec.notes } : {}),
    mutates: spec.mutates,
    output: spec.parser === "table" ? "envelope" : "legacy",
    ...(spec.aliasOf ? { aliasOf: spec.aliasOf } : {}),
    ...(spec.movedTo ? { movedTo: spec.movedTo } : {}),
    positionals: spec.positionals,
    flags: spec.flags.map(flagJson),
    examples: spec.examples,
    exitCodes: spec.exitCodes,
    errorCodes: spec.errorCodes,
  };
}

/** The whole table as data. */
export function helpJson(version: string, only?: CommandSpec) {
  return {
    name: "cms",
    version,
    note: AGENT_NOTE,
    output: {
      envelope: "commands with output \"envelope\" print one JSON object with --json: {ok, command, data, plan, warnings, error{code,message,hint,next}}",
      legacy: "plugin add (and its old name add) prints {ok, exitCode, command, events|messages} with --json and keeps its own exit codes",
      interactive: "never prompts when stdin or stdout is not a TTY, when CI is set, or with --json",
    },
    globalFlags: GLOBAL_FLAGS.map(flagJson),
    environment: ENVIRONMENT,
    exitCodes: EXIT_CODE_MEANINGS,
    errorCodes: ERROR_CODES,
    commands: (only ? [only] : COMMANDS).map(commandJson),
  };
}
