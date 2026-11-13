// Types for the declarative command table, plus the exit codes and error codes
// shared by every command that runs on the new frame.
//
// One table (commands.ts) drives the parser, the human help and `cms help --json`,
// so the three cannot drift apart. Exit codes and error codes live here because
// they are part of that same contract: agents branch on them.

export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
  /** Long name without the leading dashes, e.g. "dry-run". */
  name: string;
  /** One-letter alias, e.g. "y" for --yes. */
  short?: string;
  type: FlagType;
  /** Placeholder shown in help, e.g. "path" in `--config <path>`. */
  valueName?: string;
  default?: string | number | boolean;
  /** Environment variable that supplies the same value when the flag is absent. */
  env?: string;
  /** The value is a secret: never print it, prefer the env variable. */
  secret?: boolean;
  /** Choices for a string flag; anything else is a usage error. */
  choices?: readonly string[];
  summary: string;
}

export interface PositionalSpec {
  name: string;
  required: boolean;
  /** Takes every remaining positional (e.g. `cms help version list`). */
  variadic?: boolean;
  summary: string;
}

/**
 * What a command may change:
 *   "none"   read-only
 *   "local"  files in the site directory only
 *   "remote" Cloudflare resources or credentials
 */
export type Mutates = "none" | "local" | "remote";

export interface CommandSpec {
  /** One or two words: "status", "version list". */
  name: string;
  summary: string;
  /** Traps and details worth one more sentence than the summary. */
  notes?: readonly string[];
  positionals: readonly PositionalSpec[];
  flags: readonly FlagSpec[];
  mutates: Mutates;
  examples: readonly string[];
  exitCodes: readonly number[];
  errorCodes: readonly string[];
  /**
   * "table": parsed by the table (node:util parseArgs), gets the global flags and
   * the JSON envelope. "legacy": a 0.x command with its own parser and output,
   * listed here so help and `help --json` describe it.
   */
  parser: "table" | "legacy";
  /** Usage line override for legacy commands whose shape the table cannot express. */
  usage?: string;
}

/** Exit codes of the commands on the new frame. Fixed across commands. */
export const EXIT_CODE = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  NEEDS_USER: 3,
  REFUSED: 4,
  TRANSIENT: 5,
  CHECKS_FAILED: 10,
  CANCELLED: 130,
} as const;

export type ExitCodeValue = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

export const EXIT_CODE_MEANINGS: readonly { code: ExitCodeValue; meaning: string }[] = [
  { code: 0, meaning: "Success, including nothing to do" },
  { code: 1, meaning: "Operation failed; see error.code" },
  { code: 2, meaning: "Usage error: unknown command or flag, bad value" },
  { code: 3, meaning: "Needs the user: sign-in, a missing tool, an ambiguous account, or input required while non-interactive" },
  { code: 4, meaning: "Refused for safety" },
  { code: 5, meaning: "Transient Cloudflare error after retries; safe to run again" },
  { code: 10, meaning: "doctor found failing checks" },
  { code: 130, meaning: "Cancelled by the user" },
];

export interface ErrorCodeSpec {
  code: string;
  exit: ExitCodeValue;
  meaning: string;
}

/** Stable error codes. The string is the contract; the exit code stays coarse. */
export const ERROR_CODES: readonly ErrorCodeSpec[] = [
  { code: "UNKNOWN_COMMAND", exit: 2, meaning: "No such command" },
  { code: "UNKNOWN_FLAG", exit: 2, meaning: "No such flag for this command" },
  { code: "BAD_VALUE", exit: 2, meaning: "A flag or argument has an invalid value" },
  { code: "MISSING_ARGUMENT", exit: 2, meaning: "A required argument is missing" },
  { code: "NODE_TOO_OLD", exit: 3, meaning: "cf needs Node 22 or newer" },
  { code: "CF_MISSING", exit: 3, meaning: "cf (Cloudflare's CLI) is not installed" },
  { code: "CF_VERSION_UNSUPPORTED", exit: 3, meaning: "The installed cf is older than the supported range" },
  { code: "AUTH_REQUIRED", exit: 3, meaning: "Not signed in to Cloudflare" },
  { code: "AUTH_INVALID", exit: 3, meaning: "Cloudflare rejected the credentials" },
  { code: "PERMISSION_DENIED", exit: 3, meaning: "The credentials lack a permission this command needs" },
  { code: "ACCOUNT_AMBIGUOUS", exit: 3, meaning: "More than one Cloudflare account is visible and none is chosen" },
  { code: "INPUT_REQUIRED", exit: 3, meaning: "A prompt was needed while non-interactive" },
  { code: "CONFIG_MISSING", exit: 1, meaning: "No wrangler.jsonc in the site directory" },
  { code: "CONFIG_INVALID", exit: 1, meaning: "wrangler.jsonc cannot be read or lacks a field" },
  { code: "WORKER_NOT_FOUND", exit: 1, meaning: "The Worker has not been deployed yet" },
  { code: "CF_FAILED", exit: 1, meaning: "A cf command failed" },
  { code: "CF_INSTALL_FAILED", exit: 1, meaning: "Installing cf failed" },
  { code: "LOGIN_FAILED", exit: 1, meaning: "Signing in did not complete" },
  { code: "WRANGLER_FAILED", exit: 1, meaning: "A wrangler command failed" },
  { code: "UNEXPECTED", exit: 1, meaning: "A bug in this CLI; the message says what happened" },
  { code: "TRANSIENT", exit: 5, meaning: "Cloudflare kept failing with a temporary error" },
  { code: "CHECKS_FAILED", exit: 10, meaning: "At least one doctor check failed" },
  { code: "CANCELLED", exit: 130, meaning: "Cancelled by the user" },
];

export function exitFor(code: string): ExitCodeValue {
  return ERROR_CODES.find((e) => e.code === code)?.exit ?? EXIT_CODE.FAILED;
}

/** Flags every table command accepts. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", summary: "stdout is exactly one JSON object; never prompts" },
  { name: "dir", short: "C", type: "string", valueName: "path", summary: "the site directory (default: current directory)" },
  { name: "config", type: "string", valueName: "path", default: "wrangler.jsonc", summary: "wrangler config file, relative to the site directory" },
  { name: "account", type: "string", valueName: "id", env: "CLOUDFLARE_ACCOUNT_ID", summary: "Cloudflare account id (else account_id in wrangler.jsonc, else the only one)" },
  { name: "help", short: "h", type: "boolean", summary: "show help for the command" },
];

export const AGENT_NOTE =
  "Agents: `cms help --json` lists everything; start with `cms status` or `cms doctor`; add `--json` to any new command.";
