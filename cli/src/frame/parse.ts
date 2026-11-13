// Argument parsing for the table commands, on node:util parseArgs.
//
// Two steps: find the command words (which may come after global flags, e.g.
// `cms -C site status`), then parse the rest against that command's flags plus
// the global ones. Unknown flags and bad values become CliErrors with a
// "did you mean" — never the whole help text.

import { parseArgs } from "node:util";
import { COMMANDS } from "./commands.js";
import { CliError } from "./errors.js";
import { GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from "./spec.js";
import { nearest } from "./suggest.js";

export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface ParsedCommand {
  spec: CommandSpec;
  values: FlagValues;
  /** Flags given on the command line, before env and defaults fill the rest. */
  explicit: ReadonlySet<string>;
  positionals: string[];
  /** Everything after a bare `--`, passed through unchanged. */
  passthrough: string[];
}

/** Every flag that takes a value, across all commands, so the command scan can skip values. */
function valueFlagNames(): Set<string> {
  const names = new Set<string>();
  for (const flag of [...GLOBAL_FLAGS, ...COMMANDS.flatMap((c) => c.flags)]) {
    if (flag.type === "boolean") continue;
    names.add(`--${flag.name}`);
    if (flag.short) names.add(`-${flag.short}`);
  }
  return names;
}

/** Positions of the words that are not flags or flag values, up to a bare `--`. */
export function commandWords(argv: readonly string[]): { word: string; index: number }[] {
  const takesValue = valueFlagNames();
  const words: { word: string; index: number }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (takesValue.has(arg)) i++;
      continue;
    }
    words.push({ word: arg, index: i });
  }
  return words;
}

export type Resolution =
  | { kind: "command"; spec: CommandSpec; rest: string[] }
  | { kind: "none" }
  | { kind: "unknown"; input: string; suggestion?: string };

/** Match one or two leading words against the table; return argv without them. */
export function resolveCommand(argv: readonly string[]): Resolution {
  const words = commandWords(argv);
  if (words.length === 0) return { kind: "none" };
  const two = words.length > 1 ? `${words[0].word} ${words[1].word}` : undefined;
  const pick = (spec: CommandSpec, used: number): Resolution => {
    const drop = new Set(words.slice(0, used).map((w) => w.index));
    return { kind: "command", spec, rest: argv.filter((_, i) => !drop.has(i)) };
  };
  const byTwo = two ? COMMANDS.find((c) => c.name === two) : undefined;
  if (byTwo) return pick(byTwo, 2);
  const byOne = COMMANDS.find((c) => c.name === words[0].word);
  if (byOne) return pick(byOne, 1);
  const group = COMMANDS.filter((c) => c.name.startsWith(`${words[0].word} `)).map((c) => c.name);
  const input = two && group.length > 0 ? two : words[0].word;
  return { kind: "unknown", input, suggestion: nearest(input, COMMANDS.map((c) => c.name)) ?? group[0] };
}

function flagsOf(spec: CommandSpec): FlagSpec[] {
  return [...GLOBAL_FLAGS, ...spec.flags];
}

function unknownFlag(raw: string, spec: CommandSpec): CliError {
  const names = flagsOf(spec).map((f) => `--${f.name}`);
  const suggestion = raw.startsWith("--") ? nearest(raw, names) : undefined;
  return new CliError({
    code: "UNKNOWN_FLAG",
    message: `Unknown flag ${raw} for \`cms ${spec.name}\`.`,
    hint: suggestion ? `Did you mean ${suggestion}?` : `See \`cms help ${spec.name}\` for its flags.`,
    next: [`cms help ${spec.name}`],
  });
}

function badValue(flag: FlagSpec, spec: CommandSpec, why: string): CliError {
  return new CliError({
    code: "BAD_VALUE",
    message: `--${flag.name} ${why}.`,
    hint: `See \`cms help ${spec.name}\`.`,
    next: [`cms help ${spec.name}`],
  });
}

function coerce(flag: FlagSpec, raw: string | boolean | undefined, spec: CommandSpec): string | number | boolean {
  if (flag.type === "boolean") {
    if (typeof raw === "string") throw badValue(flag, spec, "takes no value");
    return true;
  }
  if (typeof raw !== "string" || raw === "" || raw.startsWith("-")) {
    throw badValue(flag, spec, `needs a value (--${flag.name} <${flag.valueName ?? "value"}>)`);
  }
  if (flag.choices && !flag.choices.includes(raw)) {
    throw badValue(flag, spec, `must be one of ${flag.choices.join(", ")}`);
  }
  if (flag.type === "number") {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw badValue(flag, spec, "must be a whole number");
    return n;
  }
  return raw;
}

function withDefaults(values: FlagValues, flags: readonly FlagSpec[], env: NodeJS.ProcessEnv): FlagValues {
  const out: FlagValues = { ...values };
  for (const flag of flags) {
    if (out[flag.name] !== undefined) continue;
    const fromEnv = flag.env ? env[flag.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") out[flag.name] = fromEnv;
    else if (flag.default !== undefined) out[flag.name] = flag.default;
    else if (flag.type === "boolean") out[flag.name] = false;
  }
  return out;
}

/** Parse argv (without the command words) against a table command. */
export function parseCommand(spec: CommandSpec, rest: readonly string[], env: NodeJS.ProcessEnv): ParsedCommand {
  const flags = flagsOf(spec);
  const options = Object.fromEntries(
    flags.map((f) => [f.name, { type: f.type === "boolean" ? "boolean" : "string", ...(f.short ? { short: f.short } : {}) }]),
  ) as Record<string, { type: "boolean" | "string"; short?: string }>;
  const { tokens } = parseArgs({ args: [...rest], options, strict: false, allowPositionals: true, tokens: true });

  const values: FlagValues = {};
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let afterTerminator = false;
  for (const token of tokens) {
    if (token.kind === "option-terminator") afterTerminator = true;
    else if (token.kind === "positional") (afterTerminator ? passthrough : positionals).push(token.value);
    else {
      const flag = flags.find((f) => f.name === token.name);
      if (!flag) throw unknownFlag(token.rawName, spec);
      values[flag.name] = coerce(flag, token.value, spec);
    }
  }
  checkPositionals(spec, positionals);
  return { spec, values: withDefaults(values, flags, env), explicit: new Set(Object.keys(values)), positionals, passthrough };
}

function checkPositionals(spec: CommandSpec, positionals: readonly string[]): void {
  const variadic = spec.positionals.some((p) => p.variadic);
  if (!variadic && positionals.length > spec.positionals.length) {
    throw new CliError({
      code: "BAD_VALUE",
      message: `Unexpected argument "${positionals[spec.positionals.length]}" for \`cms ${spec.name}\`.`,
      hint: `See \`cms help ${spec.name}\`.`,
      next: [`cms help ${spec.name}`],
    });
  }
  const missing = spec.positionals.find((p, i) => p.required && positionals[i] === undefined);
  if (missing) {
    throw new CliError({
      code: "MISSING_ARGUMENT",
      message: `\`cms ${spec.name}\` needs <${missing.name}>.`,
      hint: `See \`cms help ${spec.name}\`.`,
      next: [`cms help ${spec.name}`],
    });
  }
}
