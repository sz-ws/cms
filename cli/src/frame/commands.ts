// The command table. Every command is listed here, including the 0.x ones that
// keep their own parser (parser: "legacy"), so `cms help` and `cms help --json`
// always describe exactly what the CLI accepts.

import { DEFAULT_TEMPLATE } from "../create.js";
import { DEFAULT_SOURCE } from "../registry.js";
import type { CommandSpec, FlagSpec } from "./spec.js";

const CONFIG_FLAG: FlagSpec = {
  name: "config",
  type: "string",
  valueName: "path",
  default: "wrangler.jsonc",
  summary: "wrangler config file path",
};
const DRY_RUN: FlagSpec = { name: "dry-run", type: "boolean", summary: "list what would be done; create nothing, write nothing" };
const YES: FlagSpec = { name: "yes", short: "y", type: "boolean", summary: "skip all confirmations (CI use)" };
const NON_INTERACTIVE: FlagSpec = { name: "non-interactive", type: "boolean", summary: "no prompts (add: implies --force; setup: same as --yes)" };
const LEGACY_JSON: FlagSpec = { name: "json", type: "boolean", summary: "stdout gets one JSON transcript; human output stays on stderr" };
const SITE_SLUG: FlagSpec = { name: "site-slug", type: "string", valueName: "slug", summary: "site id (3-48 lowercase alnum/hyphen); Worker, D1 and R2 names derive from it" };
const SHARED_NAMES: FlagSpec = { name: "allow-shared-default-names", type: "boolean", summary: "allow the shipped shared names (cms, cms-db, ...); single-site or dev accounts only" };
const SEPARATE_TAG_CACHE: FlagSpec = { name: "separate-tag-cache", type: "boolean", summary: "give the OpenNext tag cache its own D1 (2 D1 per site)" };

/** Exit codes of the 0.x commands (exit.ts), kept as they are. */
const LEGACY_SETUP_EXITS = [0, 7, 8, 9] as const;

const LEGACY: readonly CommandSpec[] = [
  {
    name: "create",
    summary: "Scaffold a new CMS project by cloning the template",
    positionals: [{ name: "dir", required: true, summary: "directory to create" }],
    flags: [
      { name: "template", type: "string", valueName: "url", default: DEFAULT_TEMPLATE, env: "SZWS_CMS_TEMPLATE", summary: "template git URL" },
      { name: "ref", type: "string", valueName: "branch|tag", summary: "clone a specific branch or tag" },
      { name: "skip-git-init", type: "boolean", summary: "keep the template .git instead of resetting it" },
      { name: "deploy", type: "boolean", summary: "continue through deployment and first-admin setup" },
      SITE_SLUG,
      DRY_RUN,
      YES,
      NON_INTERACTIVE,
      LEGACY_JSON,
    ],
    mutates: "local",
    examples: ["cms create acme", "cms create acme --deploy", "cms create acme --template https://example.com/fork.git"],
    exitCodes: [0, 1, 2, 3, 7],
    errorCodes: [],
    parser: "legacy",
  },
  {
    name: "setup",
    summary: "Connect this repo to your Cloudflare account (D1, R2, ids, migrations, secrets)",
    positionals: [],
    flags: [
      CONFIG_FLAG,
      SITE_SLUG,
      SHARED_NAMES,
      SEPARATE_TAG_CACHE,
      { name: "skip-migrations", type: "boolean", summary: "skip applying migrations/" },
      { name: "skip-secrets", type: "boolean", summary: "skip setting SECRETS_KEY / AUTH_PEPPER / SETUP_TOKEN" },
      DRY_RUN,
      YES,
      NON_INTERACTIVE,
      LEGACY_JSON,
    ],
    mutates: "remote",
    examples: ["cms setup --site-slug acme", "cms setup --dry-run"],
    exitCodes: LEGACY_SETUP_EXITS,
    errorCodes: [],
    parser: "legacy",
  },
  {
    name: "deploy",
    summary: "Provision, build, migrate, deploy and verify this site",
    notes: ["Never rotates SECRETS_KEY or AUTH_PEPPER. First deploy reads CMS_ADMIN_EMAIL, CMS_ADMIN_NAME, CMS_ADMIN_PASSWORD and CMS_SITE_TITLE."],
    positionals: [],
    flags: [
      CONFIG_FLAG,
      SITE_SLUG,
      { name: "site-url", type: "string", valueName: "https://origin", summary: "URL for verification (default: the deployed workers.dev URL)" },
      SHARED_NAMES,
      SEPARATE_TAG_CACHE,
      DRY_RUN,
      YES,
      NON_INTERACTIVE,
      LEGACY_JSON,
    ],
    mutates: "remote",
    examples: ["cms deploy --site-slug acme", "cms deploy --dry-run"],
    exitCodes: LEGACY_SETUP_EXITS,
    errorCodes: [],
    parser: "legacy",
  },
  {
    name: "secrets",
    summary: "Ensure SECRETS_KEY / AUTH_PEPPER / SETUP_TOKEN exist on the deployed Worker (run by the postdeploy hook)",
    notes: ["Existing keys are never overwritten."],
    positionals: [],
    flags: [CONFIG_FLAG, { name: "dry-run", type: "boolean", summary: "report which keys are missing, generate nothing" }, LEGACY_JSON],
    mutates: "remote",
    examples: ["cms secrets", "cms secrets --dry-run"],
    exitCodes: LEGACY_SETUP_EXITS,
    errorCodes: [],
    parser: "legacy",
  },
  {
    name: "add",
    summary: "Install a code plugin from a registry",
    usage: "cms add <id>[@<version>] [flags]",
    positionals: [{ name: "id", required: true, summary: "plugin id, optionally @<version> kept for older cores" }],
    flags: [
      { name: "source", type: "string", valueName: "url", default: DEFAULT_SOURCE, summary: "registry base URL" },
      { name: "token", type: "string", valueName: "t", env: "SZWS_REGISTRY_TOKEN", secret: true, summary: "registry access token (prefer the env variable)" },
      { name: "force", type: "boolean", summary: "overwrite an existing extensions/<id>/" },
      { name: "skip-core-check", type: "boolean", summary: "skip the coreApi compatibility check" },
      CONFIG_FLAG,
      DRY_RUN,
      YES,
      NON_INTERACTIVE,
      LEGACY_JSON,
    ],
    mutates: "local",
    examples: ["cms add blog", "cms add blog@1.2.0 --dry-run"],
    exitCodes: [0, 1, 2, 3, 4, 6, 11],
    errorCodes: [],
    parser: "legacy",
  },
  {
    name: "preflight",
    summary: "List plugin settings that are still unset (cms doctor includes this)",
    positionals: [],
    flags: [
      CONFIG_FLAG,
      { name: "gate", type: "boolean", summary: "exit 10 when a required setting is missing (predeploy hook)" },
      LEGACY_JSON,
    ],
    mutates: "none",
    examples: ["cms preflight", "cms preflight --gate"],
    exitCodes: [0, 10],
    errorCodes: [],
    parser: "legacy",
  },
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

const SITE_ERRORS = ["CONFIG_MISSING", "CONFIG_INVALID"] as const;

const NEW: readonly CommandSpec[] = [
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
    notes: ["Includes the plugin-settings checks of `cms preflight`. Exits 10 when a check fails."],
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
    ],
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms logs", "cms logs --json", "cms logs -- --status error --method POST"],
    exitCodes: [0, 1, 2, 130],
    errorCodes: [...SITE_ERRORS, "WRANGLER_FAILED"],
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

export const COMMANDS: readonly CommandSpec[] = [...NEW, ...LEGACY, HELP];

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
  { name: "SZWS_REGISTRY_TOKEN", summary: "registry access token for `cms add`" },
  { name: "SZWS_CMS_TEMPLATE", summary: "default template URL for `cms create`" },
  { name: "CMS_ADMIN_EMAIL / CMS_ADMIN_NAME / CMS_ADMIN_PASSWORD / CMS_SITE_TITLE", summary: "first deploy: the first administrator and site title (never pass the password on the command line)" },
  { name: "CMS_SETUP_TOKEN", summary: "resume a first setup started outside `cms deploy`" },
];
