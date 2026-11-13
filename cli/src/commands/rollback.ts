// `cms rollback [version-id]`: send all traffic back to an earlier version, with the
// same call `cms deploy` uses to promote. Without an id, the previous code: every
// secret change also makes a version and a deployment, so those are skipped.
// A version that lacks secrets the live one has is refused (SECRETS_DIFFER):
// Cloudflare keeps secrets per version. The plan warns when migrations were applied
// after that version was uploaded: the old code would then run against a newer schema.

import type { AccountApi, Deployment, WorkerVersion } from "../cloudflare/port.js";
import type { Ctx, Outcome, PlanItem } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { readSite, type Site } from "../site/site.js";
import { connect } from "./connect.js";
import { confirmPlan } from "./confirm.js";
import { shortId, utc } from "./format.js";

function mainVersion(d: Deployment | undefined): string | undefined {
  return d ? [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.versionId : undefined;
}

/** Deployments that changed code, newest first: secret changes also create deployments, and are skipped. */
function codeDeployments(deployments: readonly Deployment[]): Deployment[] {
  return deployments.filter((d) => d.triggeredBy !== "secret");
}

function pickTarget(given: string | undefined, deployments: Deployment[], versions: WorkerVersion[]): WorkerVersion {
  if (given) {
    const matches = versions.filter((v) => v.id === given || (given.length >= 8 && v.id.startsWith(given)));
    if (matches.length === 1) return matches[0];
    throw new CliError({
      code: "BAD_VALUE",
      message: matches.length === 0 ? `No version ${given} among the Worker's last ${versions.length} versions.` : `${given} matches more than one version; give more characters.`,
      next: ["cms version list"],
    });
  }
  // The code live now is the newest code deployment; the previous code is the one before it.
  const code = codeDeployments(deployments);
  const liveCode = mainVersion(code[0]);
  const previous = code.slice(1).map(mainVersion).find((id) => id && id !== liveCode);
  const version = versions.find((v) => v.id === previous);
  if (!version) {
    throw new CliError({ code: "NOTHING_TO_ROLL_BACK", message: "There is no earlier code deployment to go back to.", hint: "Secret changes are deployments too, but they are not earlier code. Name a version: see `cms version list`.", next: ["cms version list"] });
  }
  return version;
}

/** Refuse a version that lacks secrets the live one has: Cloudflare keeps secrets per version. */
async function checkSecrets(api: AccountApi, worker: string, target: string, live: string | undefined): Promise<void> {
  if (!live) return;
  const [theirs, ours] = await Promise.all([api.versionSecrets(worker, target), api.versionSecrets(worker, live)]);
  const missing = ours.filter((n) => !theirs.includes(n));
  if (missing.length === 0) return;
  throw new CliError({
    code: "SECRETS_DIFFER",
    message: `Version ${shortId(target)} does not have ${missing.join(", ")}, which the live version has. Nothing was changed.`,
    hint: "Cloudflare keeps secrets per version, so that version would run without them. To go back to older code, check that code out and run cms deploy; the secrets stay.",
    next: ["cms version list"],
    data: { missing },
  });
}

/** Migrations recorded after the target was uploaded, per database that has a migrations_dir. */
async function laterMigrations(site: Site, api: AccountApi, uploadedAt: string): Promise<string[]> {
  const since = Date.parse(uploadedAt);
  const names: string[] = [];
  for (const db of site.d1.filter((d) => d.id && d.migrationsDir)) {
    const rows = await api.d1Query(db.id!, "SELECT name, applied_at FROM d1_migrations ORDER BY id");
    for (const row of rows) {
      const at = Date.parse(`${String(row.applied_at).replace(" ", "T")}Z`);
      if (at > since) names.push(String(row.name));
    }
  }
  return names;
}

export async function runRollback(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { port, account } = await connect(ctx, site.accountId);
  const api = port.account(account.id);
  const [deployments, versions] = await ctx.progress("Reading versions", () =>
    Promise.all([api.deployments(site.workerName, 10), api.versions(site.workerName, 100)]),
  );
  if (deployments === null || versions === null) {
    throw new CliError({ code: "WORKER_NOT_FOUND", message: `The Worker ${site.workerName} does not exist on this account.`, next: ["cms status"] });
  }
  const current = mainVersion(deployments[0]);
  const target = pickTarget(ctx.positionals[0], deployments, versions);
  if (target.id === current) {
    return { data: { worker: site.workerName, from: current, to: target.id, changed: false }, text: `Version ${shortId(target.id)} is already live; nothing to do.` };
  }
  await checkSecrets(api, site.workerName, target.id, current);
  const later = await laterMigrations(site, api, target.createdOn);
  if (later.length > 0) {
    ctx.warn("SCHEMA_AHEAD", `${later.length} migration(s) were applied after version ${shortId(target.id)} was uploaded (${later.join(", ")}). Its code will run against the newer schema; migrations are not rolled back.`);
  }
  const plan: PlanItem[] = [{ action: "promote", type: "version", name: `${target.id} to 100%` }];
  const lines = ["   Plan", `   ~ version  ${current ? shortId(current) : "?"} → ${shortId(target.id)} (uploaded ${utc(target.createdOn)})`];
  const data = { worker: site.workerName, from: current ?? null, to: target.id, laterMigrations: later };
  if (ctx.values["dry-run"] === true) return { data: { ...data, dryRun: true }, plan, text: [...lines, "", "   Dry run: nothing was changed."].join("\n") };
  if (!ctx.json) ctx.say(["", ...lines, ""].join("\n"));
  await confirmPlan(ctx, plan, "Send all traffic to this version?");
  await ctx.progress("Rolling back", () => api.promote(site.workerName, target.id));
  return { data: { ...data, changed: true }, plan, text: `Version ${shortId(target.id)} is live.` };
}
