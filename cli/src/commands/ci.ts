// `cms ci token`: the API token permissions this site's commands need, derived from
// what they call. `cms ci init`: a GitHub Actions workflow that deploys or rolls
// back by hand. Neither touches Cloudflare.
//
// `ci token --create` is not offered: `cf accounts tokens create` takes policies
// whose "resources" object cf describes only as {...}, so the token could not be
// built from cf's own description (cf schema, --dry-run) alone.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CF_TESTED } from "../cloudflare/cf-binary.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readSite } from "../site/site.js";
import { padVisual } from "../ui.js";
import { VERSION } from "../version.js";
import { installCommand } from "./deploy/project.js";

export interface Permission {
  group: string;
  scope: "account" | "zone";
  neededBy: string;
}

const ACCOUNT: readonly Permission[] = [
  { group: "Workers Scripts Write", scope: "account", neededBy: "deploy (upload, go live, secrets), rollback, secret set/delete, destroy; status and version list read the Worker" },
  { group: "D1 Write", scope: "account", neededBy: "deploy (create the database, migrations, site URL, first admin), destroy; status and rollback read it" },
  { group: "Workers R2 Storage Write", scope: "account", neededBy: "deploy (create buckets, the lifecycle rule, the stored-page upload), destroy" },
  { group: "Workers KV Storage Read", scope: "account", neededBy: "status and doctor (a leftover 1.x namespace); Write instead if destroy should delete it" },
  { group: "Account Settings Read", scope: "account", neededBy: "cf and wrangler finding the account (whoami)" },
  { group: "Workers Observability Read", scope: "account", neededBy: "logs --since" },
  { group: "Workers Tail Read", scope: "account", neededBy: "logs (live tail through wrangler)" },
];

const ZONE: readonly Permission[] = [
  { group: "Workers Routes Write", scope: "zone", neededBy: "deploy attaching the custom domains in wrangler.jsonc" },
  { group: "DNS Write", scope: "zone", neededBy: "deploy creating the custom domains' DNS records" },
  { group: "Zone Read", scope: "zone", neededBy: "deploy finding the zone of each custom domain" },
];

export async function runCiToken(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const domains = site.routes.filter((r) => r.customDomain).map((r) => r.url.replace(/^https:\/\//, ""));
  const permissions = [...ACCOUNT, ...(domains.length > 0 ? ZONE : [])];
  const width = Math.max(...permissions.map((p) => p.group.length)) + 2;
  const text = [
    `API token for ${site.workerName}: an account API token with these permissions${site.accountId ? ` on account ${site.accountId}` : ""}.`,
    "",
    ...permissions.map((p) => `  ${padVisual(p.group, width)}${padVisual(p.scope, 9)}${p.neededBy}`),
    ...(domains.length > 0 ? ["", `Zone permissions only on the zones of: ${domains.join(", ")}.`] : []),
    "",
    "Create it in the Cloudflare dashboard (Manage Account → Account API Tokens → Create Token → Custom token).",
    "In CI set it as CLOUDFLARE_API_TOKEN, with CLOUDFLARE_ACCOUNT_ID; cf and wrangler both read them.",
  ].join("\n");
  return { data: { worker: site.workerName, permissions, zones: domains }, text };
}

/** The command a workflow runs: the repository's own CLI when it has one, else the published package. */
function cliCommand(dir: string): string {
  return existsSync(path.join(dir, "scripts", "cms.mjs")) ? "node scripts/cms.mjs" : `npx --yes @sz.ws/cms@${VERSION}`;
}

export function workflowText(cli: string, install: string): string {
  return `# Deploy or roll back this site by hand: Actions → cms → Run workflow.
# Written by \`cms ci init\`. Needs two repository secrets:
#   CLOUDFLARE_API_TOKEN   permissions: see \`cms ci token\`
#   CLOUDFLARE_ACCOUNT_ID  the account that holds the site
# A first deploy also needs CMS_ADMIN_EMAIL, CMS_ADMIN_NAME, CMS_SITE_TITLE and
# CMS_ADMIN_PASSWORD; run the first deploy from a terminal instead.
name: cms

on:
  workflow_dispatch:
    inputs:
      action:
        description: deploy, or rollback
        type: choice
        options: [deploy, rollback]
        default: deploy
      version:
        description: "rollback: version id (empty = the previous version)"
        required: false

concurrency:
  group: cms-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  cms:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - run: ${install}
      - run: npm install -g cf@${CF_TESTED}
      - if: inputs.action == 'deploy'
        run: ${cli} deploy --yes --json
      - if: inputs.action == 'rollback'
        run: ${cli} rollback \${{ inputs.version }} --yes --json
`;
}

export async function runCiInit(ctx: Ctx): Promise<Outcome> {
  const file = path.join(ctx.cwd, ".github", "workflows", "cms.yml");
  const shown = path.relative(ctx.cwd, file);
  if (existsSync(file) && ctx.values.force !== true) {
    throw new CliError({ code: "DEST_EXISTS", message: `${shown} already exists; it was not changed.`, hint: "Overwrite it with --force.", next: [`cms ci init --force`] });
  }
  const { cmd, args } = installCommand(ctx.cwd);
  const text = workflowText(cliCommand(ctx.cwd), [cmd, ...args].join(" "));
  const dryRun = ctx.values["dry-run"] === true;
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }
  return {
    data: { file: shown, dryRun },
    plan: [{ action: "write", type: "file", name: shown }],
    text: `${dryRun ? "Would write" : "Wrote"} ${shown}. Add the repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see cms ci token), then run it from Actions.`,
  };
}
