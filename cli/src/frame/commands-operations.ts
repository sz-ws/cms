// Command table entries for the day-to-day operations: rollback, domains,
// secrets, CI and destroy. Part of the one table in commands.ts.

import type { CommandSpec, FlagSpec } from "./spec.js";

const DRY_RUN: FlagSpec = { name: "dry-run", type: "boolean", summary: "show what would change; change nothing" };
const YES: FlagSpec = { name: "yes", short: "y", type: "boolean", summary: "accept without asking (CI, agents)" };

const CONNECT = ["NODE_TOO_OLD", "CF_MISSING", "CF_VERSION_UNSUPPORTED", "AUTH_REQUIRED", "AUTH_INVALID", "PERMISSION_DENIED", "ACCOUNT_AMBIGUOUS", "TRANSIENT", "CF_FAILED", "CANCELLED"];
const SITE = ["CONFIG_MISSING", "CONFIG_INVALID"];
const REMOTE_EXITS = [0, 1, 2, 3, 4, 5, 130] as const;

const host = (summary: string) => [{ name: "host", required: true, summary }];
const secretName = [{ name: "NAME", required: true, summary: "secret name, e.g. EXT_SHOP_API_KEY" }];

export const OPERATIONS: readonly CommandSpec[] = [
  {
    name: "rollback",
    summary: "Send all traffic back to an earlier version (the previous one by default)",
    notes: ["Warns when migrations ran after that version was uploaded: its code would meet a newer schema. Migrations are not rolled back."],
    positionals: [{ name: "version-id", required: false, summary: "a version id or its first 8+ characters (see cms version list)" }],
    flags: [DRY_RUN, YES],
    mutates: "remote",
    examples: ["cms rollback --dry-run", "cms rollback", "cms rollback 3f2a91c0 --yes --json"],
    exitCodes: REMOTE_EXITS,
    errorCodes: [...SITE, ...CONNECT, "WORKER_NOT_FOUND", "NOTHING_TO_ROLL_BACK", "BAD_VALUE", "CONFIRMATION_REQUIRED"],
    parser: "table",
  },
  {
    name: "domain list",
    summary: "Custom domains declared in wrangler.jsonc",
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms domain list", "cms domain list --json"],
    exitCodes: [0, 1, 2],
    errorCodes: SITE,
    parser: "table",
  },
  {
    name: "domain add",
    summary: "Declare a custom domain in wrangler.jsonc; it is attached at the next cms deploy",
    notes: ["Changes only wrangler.jsonc (comments kept). core.siteUrl is not changed: set it in admin → Settings if this becomes the main address."],
    positionals: host("host name, e.g. www.example.com"),
    flags: [DRY_RUN],
    mutates: "local",
    examples: ["cms domain add www.example.com", "cms domain add www.example.com --dry-run --json"],
    exitCodes: [0, 1, 2],
    errorCodes: [...SITE, "BAD_VALUE"],
    parser: "table",
  },
  {
    name: "domain remove",
    summary: "Remove a custom domain from wrangler.jsonc",
    notes: ["Changes only wrangler.jsonc. If the domain stays attached after the next deploy, detach it in the dashboard."],
    positionals: host("host name to remove"),
    flags: [DRY_RUN],
    mutates: "local",
    examples: ["cms domain remove www.example.com"],
    exitCodes: [0, 1, 2],
    errorCodes: [...SITE, "BAD_VALUE", "DOMAIN_NOT_FOUND"],
    parser: "table",
  },
  {
    name: "secret list",
    summary: "The Worker's secret names (never values)",
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms secret list", "cms secret list --json"],
    exitCodes: [0, 1, 2, 3, 5, 130],
    errorCodes: [...SITE, ...CONNECT, "WORKER_NOT_FOUND"],
    parser: "table",
  },
  {
    name: "secret set",
    summary: "Set a Worker secret; the value comes from stdin or a hidden prompt, never a flag",
    notes: ["Replacing an existing secret asks first (--yes in CI). SECRETS_KEY, AUTH_PEPPER and SETUP_TOKEN are refused (exit 4)."],
    positionals: secretName,
    flags: [DRY_RUN, YES],
    mutates: "remote",
    examples: ['printf %s "$VALUE" | cms secret set EXT_SHOP_API_KEY', "cms secret set EXT_SHOP_API_KEY"],
    exitCodes: REMOTE_EXITS,
    errorCodes: [...SITE, ...CONNECT, "WORKER_NOT_FOUND", "MANAGED_SECRET", "BAD_VALUE", "INPUT_REQUIRED", "CONFIRMATION_REQUIRED"],
    parser: "table",
  },
  {
    name: "secret delete",
    summary: "Delete a Worker secret",
    notes: ["SECRETS_KEY, AUTH_PEPPER and SETUP_TOKEN are refused (exit 4)."],
    positionals: secretName,
    flags: [DRY_RUN, YES],
    mutates: "remote",
    examples: ["cms secret delete EXT_OLD_KEY", "cms secret delete EXT_OLD_KEY --yes --json"],
    exitCodes: REMOTE_EXITS,
    errorCodes: [...SITE, ...CONNECT, "WORKER_NOT_FOUND", "MANAGED_SECRET", "SECRET_NOT_FOUND", "CONFIRMATION_REQUIRED"],
    parser: "table",
  },
  {
    name: "ci token",
    summary: "The API token permissions this site's commands need, and which command needs which",
    notes: ["Read-only; creates nothing. Create the token in the dashboard and set it as CLOUDFLARE_API_TOKEN."],
    positionals: [],
    flags: [],
    mutates: "none",
    examples: ["cms ci token", "cms ci token --json"],
    exitCodes: [0, 1, 2],
    errorCodes: SITE,
    parser: "table",
  },
  {
    name: "ci init",
    summary: "Write .github/workflows/cms.yml: deploy or roll back by hand from GitHub Actions",
    positionals: [],
    flags: [{ name: "force", type: "boolean", summary: "overwrite an existing workflow file" }, DRY_RUN],
    mutates: "local",
    examples: ["cms ci init", "cms ci init --force"],
    exitCodes: [0, 1, 2],
    errorCodes: ["DEST_EXISTS"],
    parser: "table",
  },
  {
    name: "destroy",
    summary: "Delete the site's Worker, D1 database, R2 buckets and declared KV, after typing the Worker name",
    notes: [
      "Cannot be undone. Only resources named in wrangler.jsonc. A bucket that still holds objects is refused (BUCKET_NOT_EMPTY).",
      "Non-interactive runs need --yes and --confirm <worker-name>; --yes alone is never enough.",
    ],
    positionals: [],
    flags: [DRY_RUN, YES, { name: "confirm", type: "string", valueName: "worker-name", summary: "the Worker name, typed out (needed with --yes)" }],
    mutates: "remote",
    examples: ["cms destroy --dry-run", "cms destroy", "cms destroy --yes --confirm cms-acme --json"],
    exitCodes: REMOTE_EXITS,
    errorCodes: [...SITE, ...CONNECT, "BUCKET_NOT_EMPTY", "CONFIRMATION_REQUIRED", "BAD_VALUE"],
    parser: "table",
  },
];
