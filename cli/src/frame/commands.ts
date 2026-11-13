// The command table. Every command is listed here, including `plugin add` (which
// keeps its own parser, parser: "legacy") and the 0.x names kept for one release,
// so `cms help` and `cms help --json` always describe exactly what the CLI accepts.

import { DEFAULT_TEMPLATE } from "../create.js";
import { DEFAULT_SOURCE } from "../registry.js";
import { OPERATIONS } from "./commands-operations.js";
import { PLUGIN_COMMANDS_MORE } from "./commands-plugins.js";
import type { CommandSpec, FlagSpec } from "./spec.js";

const SITE_ERRORS = ["CONFIG_MISSING", "CONFIG_INVALID"] as const;

const DRY_RUN: FlagSpec = { name: "dry-run", type: "boolean", summary: "do every read and show the plan; change nothing" };
const YES: FlagSpec = { name: "yes", short: "y", type: "boolean", summary: "accept the plan without asking (CI, agents)" };
const LEGACY_JSON: FlagSpec = { name: "json", type: "boolean", summary: "stdout gets one JSON transcript; human output stays on stderr" };
const NAME: FlagSpec = { name: "name", type: "string", valueName: "name", env: "CMS_SITE_NAME", summary: "site name for a new site (3-48 lowercase letters, digits, hyphens); Worker, D1 and R2 names derive from it" };

const DEPLOY_FLAGS: readonly FlagSpec[] = [
  NAME,
  { name: "site-url", type: "string", valueName: "https://origin", summary: "the site's URL for core.siteUrl and the check (default: the workers.dev URL)" },
  { name: "admin-email", type: "string", valueName: "email", env: "CMS_ADMIN_EMAIL", summary: "first deploy: the first administrator's email" },
  { name: "admin-name", type: "string", valueName: "name", env: "CMS_ADMIN_NAME", summary: "first deploy: the first administrator's name" },
  { name: "site-title", type: "string", valueName: "title", env: "CMS_SITE_TITLE", summary: "first deploy: the site title" },
  DRY_RUN,
  YES,
];

const DEPLOY_ERRORS = [
  "PROJECT_INVALID", "CONFIG_MISSING", "CONFIG_INVALID", "INPUT_REQUIRED", "SETTINGS_MISSING", "NAME_IN_USE", "CONFIRMATION_REQUIRED",
  "NODE_TOO_OLD", "CF_MISSING", "CF_VERSION_UNSUPPORTED", "AUTH_REQUIRED", "AUTH_INVALID", "PERMISSION_DENIED", "ACCOUNT_AMBIGUOUS",
  "DEPENDENCIES_FAILED", "CONFIG_WRITE_FAILED", "RESOURCE_FAILED", "BUILD_FAILED", "UPLOAD_REJECTED", "MIGRATION_FAILED",
  "PROMOTE_FAILED", "DEPLOY_FAILED", "SECRETS_UNREADABLE", "SECRETS_FAILED", "SITE_URL_UNKNOWN", "ADMIN_FAILED", "HTTP_CHECK_FAILED",
  "TRANSIENT", "CF_FAILED", "FLAG_REMOVED", "CANCELLED",
];

const INIT_FLAGS: readonly FlagSpec[] = [
  { name: "template", type: "string", valueName: "url", default: DEFAULT_TEMPLATE, env: "SZWS_CMS_TEMPLATE", summary: "template git URL" },
  { name: "ref", type: "string", valueName: "branch|tag", summary: "clone this branch or tag instead of the newest release tag" },
  { name: "skip-git-init", type: "boolean", summary: "keep the template's .git instead of starting a new history" },
  { name: "deploy", type: "boolean", summary: "continue with cms deploy in the new directory (its name becomes the site name)" },
  ...DEPLOY_FLAGS.filter((f) => f.name !== "name"),
];

const INIT_ERRORS = ["BAD_VALUE", "INPUT_REQUIRED", "DEST_EXISTS", "GIT_MISSING", "CLONE_FAILED", ...DEPLOY_ERRORS];

const PLUGIN_ADD_FLAGS: readonly FlagSpec[] = [
  { name: "source", type: "string", valueName: "url", default: DEFAULT_SOURCE, summary: "registry base URL" },
  { name: "token", type: "string", valueName: "t", env: "SZWS_REGISTRY_TOKEN", secret: true, summary: "registry access token (prefer the env variable)" },
  { name: "force", type: "boolean", summary: "overwrite an existing extensions/<id>/" },
  { name: "skip-core-check", type: "boolean", summary: "skip the coreApi compatibility check" },
  { name: "config", type: "string", valueName: "path", default: "wrangler.jsonc", summary: "wrangler config file path" },
  { name: "dry-run", type: "boolean", summary: "list what would be done; write nothing" },
  { name: "yes", short: "y", type: "boolean", summary: "skip the settings questions" },
  { name: "non-interactive", type: "boolean", summary: "no prompts; implies --force" },
  LEGACY_JSON,
];

const SITE_COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Create a new site project from the newest release of the template",
    notes: ["Clones the newest release tag; when the template has none, its default branch (and says so). No Cloudflare calls unless --deploy."],
    positionals: [{ name: "dir", required: false, summary: "directory to create (asked for when missing)" }],
    flags: INIT_FLAGS,
    mutates: "local",
    examples: ["cms init acme", "cms init acme --deploy", "cms init acme --ref v2.0.0 --dry-run"],
    exitCodes: [0, 1, 2, 3, 4, 5, 130],
    errorCodes: INIT_ERRORS,
    parser: "table",
  },
  {
    name: "deploy",
    summary: "Converge the site: resources, build, upload, migrate, go live, secrets, first admin, check",
    notes: [
      "Shows the plan and asks before changing anything; --dry-run stops after the plan, --yes accepts it.",
      "An existing Worker gets a new version that goes live only after the migrations. Never rotates SECRETS_KEY or AUTH_PEPPER.",
      "Passwords only through the environment (CMS_ADMIN_PASSWORD) or a hidden prompt. Step output goes to .cms/logs/.",
      "Builds and uploads with the project's OpenNext and wrangler, so wrangler must be signed in too (or CLOUDFLARE_API_TOKEN set).",
    ],
    positionals: [],
    flags: DEPLOY_FLAGS,
    mutates: "remote",
    examples: ["cms deploy --dry-run", "cms deploy", "cms deploy --name acme --yes --json", "cms deploy --site-url https://www.example.com"],
    exitCodes: [0, 1, 2, 3, 4, 5, 130],
    errorCodes: DEPLOY_ERRORS,
    parser: "table",
  },
];

const PLUGIN_COMMANDS: readonly CommandSpec[] = [
  {
    name: "plugin add",
    summary: "Install a code plugin from a registry",
    usage: "cms plugin add <id>[@<version>] [flags]",
    positionals: [{ name: "id", required: true, summary: "plugin id, optionally @<version> kept for older cores" }],
    flags: PLUGIN_ADD_FLAGS,
    mutates: "local",
    examples: ["cms plugin add blog", "cms plugin add blog@1.2.0 --dry-run"],
    exitCodes: [0, 1, 2, 3, 4, 6, 11],
    errorCodes: [],
    parser: "legacy",
  },
];

/** 0.x names kept for one release. */
const KEPT: readonly CommandSpec[] = [
  {
    name: "create",
    summary: "Old name of `cms init` (prints a notice)",
    positionals: [{ name: "dir", required: false, summary: "directory to create" }],
    flags: INIT_FLAGS,
    mutates: "local",
    examples: ["cms init acme"],
    exitCodes: [0, 1, 2, 3, 4, 5, 130],
    errorCodes: INIT_ERRORS,
    parser: "table",
    aliasOf: "init",
  },
  {
    name: "setup",
    summary: "Folded into `cms deploy`: see the plan with `cms deploy --dry-run`",
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms deploy --dry-run", "cms deploy"],
    exitCodes: [2],
    errorCodes: ["COMMAND_MOVED"],
    parser: "table",
    movedTo: ["cms deploy --dry-run", "cms deploy"],
  },
  {
    name: "secrets",
    summary: "Create any missing SECRETS_KEY / AUTH_PEPPER / SETUP_TOKEN on the deployed Worker (old postdeploy hooks call it)",
    notes: ["cms deploy does this itself. Existing keys are never overwritten; a new SETUP_TOKEN is printed once on stderr."],
    positionals: [],
    flags: [DRY_RUN],
    mutates: "remote",
    examples: ["cms secrets", "cms secrets --dry-run --json"],
    exitCodes: [0, 1, 2, 3, 5, 130],
    errorCodes: [...SITE_ERRORS, "SECRETS_UNREADABLE", "SECRETS_FAILED", "AUTH_REQUIRED", "CF_MISSING", "ACCOUNT_AMBIGUOUS"],
    parser: "table",
  },
  {
    name: "preflight",
    summary: "The plugin-settings checks of `cms doctor` (old predeploy hooks call it)",
    notes: ["With --gate, exits 10 when a required setting is empty. Without a Cloudflare login, secret settings show as unverifiable, not missing."],
    positionals: [],
    flags: [{ name: "gate", type: "boolean", summary: "exit 10 when a required setting is missing" }],
    mutates: "none",
    examples: ["cms preflight", "cms preflight --gate"],
    exitCodes: [0, 1, 2, 10],
    errorCodes: [...SITE_ERRORS, "CHECKS_FAILED"],
    parser: "table",
  },
  { ...PLUGIN_COMMANDS[0], name: "add", summary: "Old name of `cms plugin add`", usage: "cms add <id>[@<version>] [flags]", examples: ["cms plugin add blog"], aliasOf: "plugin add" },
];

const CONNECT_ERRORS = [
  "NODE_TOO_OLD",
  "CF_MISSING",
  "CF_VERSION_UNSUPPORTED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "PERMISSION_DENIED",
  "ACCOUNT_AMBIGUOUS",
  "TRANSIENT",
  "CF_FAILED",
  "CANCELLED",
] as const;


const READ_COMMANDS: readonly CommandSpec[] = [
  {
    name: "status",
    summary: "What exists: account, Worker, live version, URLs, resources, secrets, migrations, plugins",
    notes: ["Read-only. Secret values are never read, only names."],
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms status", "cms status --json", "cms status -C ../acme"],
    exitCodes: [0, 1, 2, 3, 5, 130],
    errorCodes: [...SITE_ERRORS, ...CONNECT_ERRORS],
    parser: "table",
  },
  {
    name: "doctor",
    summary: "Checks with pass / warn / fail, each with a hint and the next command",
    notes: ["Includes the plugin-settings checks (formerly `cms preflight`). Exits 10 when a check fails."],
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms doctor", "cms doctor --json"],
    exitCodes: [0, 1, 2, 10, 130],
    errorCodes: ["CHECKS_FAILED", "CANCELLED"],
    parser: "table",
  },
  {
    name: "login",
    summary: "Sign in to Cloudflare through cf; reports where auth comes from when already signed in",
    notes: [
      "cf shows a code to approve in any browser, on this machine or another one.",
      "Non-interactive runs do not start a sign-in: set CLOUDFLARE_API_TOKEN instead.",
    ],
    positionals: [],
    flags: [],
    mutates: "remote",
    examples: ["cms login", "cms login --json"],
    exitCodes: [0, 1, 2, 3, 130],
    errorCodes: ["NODE_TOO_OLD", "CF_MISSING", "CF_VERSION_UNSUPPORTED", "CF_INSTALL_FAILED", "AUTH_REQUIRED", "LOGIN_FAILED", "CANCELLED"],
    parser: "table",
  },
  {
    name: "version list",
    summary: "Uploaded Worker versions, newest first, with the share of traffic each one serves",
    positionals: [],
    flags: [{ name: "limit", type: "number", valueName: "n", default: 10, summary: "how many versions to show (1-100)" }],
    mutates: "none",
    examples: ["cms version list", "cms version list --limit 3 --json"],
    exitCodes: [0, 1, 2, 3, 5, 130],
    errorCodes: [...SITE_ERRORS, ...CONNECT_ERRORS, "WORKER_NOT_FOUND", "BAD_VALUE"],
    parser: "table",
  },
  {
    name: "logs",
    summary: "Live tail of the Worker's logs (through the project's wrangler) until Ctrl-C",
    notes: [
      "With --json, stdout is a stream of JSON events (one per line), not one envelope.",
      "Arguments after `--` go to `wrangler tail` unchanged, e.g. `cms logs -- --status error`.",
      "--since reads errors (level error, or a failed invocation) through cf's Workers Logs query; observability must be on for the Worker.",
    ],
    positionals: [],
    flags: [
      { name: "since", type: "string", valueName: "duration", summary: "recent errors from Workers Logs instead of a live tail: 15m, 2h, 3d (at most 7d)" },
      { name: "limit", type: "number", valueName: "n", default: 50, summary: "with --since: how many events (1-500)" },
    ],
    mutates: "none",
    examples: ["cms logs", "cms logs --since 1h", "cms logs --since 1d --json", "cms logs -- --status error --method POST"],
    exitCodes: [0, 1, 2, 130],
    errorCodes: [...SITE_ERRORS, "WRANGLER_FAILED", "BAD_VALUE", ...CONNECT_ERRORS],
    parser: "table",
  },
];

const HELP: CommandSpec = {
  name: "help",
  summary: "Show help; `cms help --json` prints the whole command table as data",
  positionals: [{ name: "command", required: false, variadic: true, summary: "command to describe" }],
  flags: [],
  mutates: "none",
  examples: ["cms help", "cms help status", "cms help --json"],
  exitCodes: [0, 2],
  errorCodes: ["UNKNOWN_COMMAND"],
  parser: "table",
};

export const COMMANDS: readonly CommandSpec[] = [...SITE_COMMANDS, ...READ_COMMANDS, ...OPERATIONS, ...PLUGIN_COMMANDS, ...PLUGIN_COMMANDS_MORE, HELP, ...KEPT];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** `cms version` alone prints the CLI version (kept from 0.x); `cms version list` is a command. */
export const VERSION_COMMAND_NOTE = "`cms version` / `cms --version` print the CLI version.";

/** Environment variables the CLI reads, for help and `help --json`. */
export const ENVIRONMENT: readonly { name: string; summary: string }[] = [
  { name: "CLOUDFLARE_API_TOKEN", summary: "Cloudflare API token; used instead of a browser login (CI, agents)" },
  { name: "CLOUDFLARE_ACCOUNT_ID", summary: "which account to use when the login sees several" },
  { name: "CI", summary: "when set, never prompt" },
  { name: "NO_COLOR", summary: "disable colours" },
  { name: "CMS_SITE_NAME", summary: "site name for a new site (same as --name)" },
  { name: "CMS_ADMIN_EMAIL / CMS_ADMIN_NAME / CMS_SITE_TITLE", summary: "first deploy: the first administrator and site title (same as the flags)" },
  { name: "CMS_ADMIN_PASSWORD", summary: "first deploy: the administrator password; never on the command line" },
  { name: "CMS_SETUP_TOKEN", summary: "resume a first setup whose SETUP_TOKEN value is not in .cms/" },
  { name: "SZWS_REGISTRY_TOKEN", summary: "registry access token for `cms plugin add`" },
  { name: "SZWS_CMS_TEMPLATE", summary: "default template URL for `cms init`" },
];
