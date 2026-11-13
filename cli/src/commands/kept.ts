// 0.x commands kept for one release: `secrets` and `preflight`. Old site
// repositories call them from their postdeploy and predeploy hooks.

import path from "node:path";
import { CloudflareError } from "../cloudflare/port.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError, isCliError } from "../frame/errors.js";
import { readSite } from "../site/site.js";
import { againCommand, connect } from "./connect.js";
import { settingsChecks } from "./doctor-checks.js";
import { renderDoctor } from "./doctor.js";
import { ensureManagedSecrets } from "./managed-secrets.js";
import { SETUP_TOKEN } from "../secrets.js";

export async function runSecretsCommand(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { port, account } = await connect(ctx, site.accountId);
  const dryRun = ctx.values["dry-run"] === true;
  const result = await ensureManagedSecrets(port.account(account.id), site.workerName, {
    dryRun,
    again: againCommand(ctx),
    onSetupToken: async (value) => {
      // Shown once, on stderr only: wrangler and cf cannot read a secret back.
      ctx.say(`${SETUP_TOKEN} (copy it now, it cannot be shown again; paste it into /setup): ${value}`);
    },
  });
  const lines = [
    ...result.present.map((n) => `✓  ${n} already set (never overwritten)`),
    ...result.missing.map((n) => (dryRun ? `+  ${n} would be created` : `✓  ${n} created`)),
  ];
  return { data: { worker: site.workerName, dryRun, ...result }, text: lines.join("\n") };
}

/** Secret names when Cloudflare can be reached without asking anything; null otherwise. */
async function secretNamesQuietly(ctx: Ctx, accountId: string | undefined, worker: string): Promise<string[] | null> {
  try {
    const { port, account } = await connect({ ...ctx, interactive: false }, accountId);
    return await port.account(account.id).secretNames(worker);
  } catch (e) {
    if (isCliError(e) || e instanceof CloudflareError) return null;
    throw e;
  }
}

export async function runPreflightCommand(ctx: Ctx): Promise<Outcome> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const names = await secretNamesQuietly(ctx, site.accountId, site.workerName);
  const checks = await settingsChecks(site.dir, path.resolve(ctx.cwd, String(ctx.values.config)), names);
  if (names === null) {
    ctx.warn("SECRETS_UNVERIFIED", "The Worker's secret names could not be read (not signed in, or not deployed yet); secret settings are unverified, not missing.");
  }
  const failed = checks.filter((c) => c.status === "fail");
  const error =
    ctx.values.gate === true && failed.length > 0
      ? new CliError({ code: "CHECKS_FAILED", message: `${failed.length} required plugin settings are empty.`, next: [...new Set(failed.flatMap((c) => c.next ?? []))], exit: 10 })
      : undefined;
  return { data: { checks }, text: renderDoctor(checks, ctx.out), error };
}
