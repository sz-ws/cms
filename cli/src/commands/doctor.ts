// `cms doctor`: every check, never a prompt. A missing tool or login is a failing
// check with the command to run, not an error that hides the other checks.
// Exit 10 when a check fails.

import { CloudflareError, type CloudflarePort, type Identity } from "../cloudflare/port.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError, isCliError } from "../frame/errors.js";
import { toCliError } from "../frame/output.js";
import { readSite, type Site } from "../site/site.js";
import type { StyleSet } from "../ui.js";
import { padVisual } from "../ui.js";
import { againCommand, chooseAccount } from "./connect.js";
import { cfCheck, nodeCheck, settingsChecks, siteChecks, type Check } from "./doctor-checks.js";
import { gatherStatus } from "./status-data.js";

function errorCheck(id: string, title: string, e: CliError): Check {
  return { id, status: "fail", title, detail: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.next.length > 0 ? { next: [...e.next] } : {}) };
}

async function siteCheck(ctx: Ctx): Promise<{ site?: Site; check: Check }> {
  try {
    const site = await readSite(ctx.cwd, String(ctx.values.config));
    return { site, check: { id: "config", status: "pass", title: "Config", detail: `${String(ctx.values.config)}, Worker ${site.workerName}` } };
  } catch (e) {
    if (!isCliError(e)) throw e;
    return { check: errorCheck("config", "Config", e) };
  }
}

async function authCheck(port: CloudflarePort): Promise<{ identity?: Identity; check: Check }> {
  const identity = await port.whoami();
  if (!identity.authenticated) {
    return { check: { id: "auth", status: "fail", title: "Signed in", detail: "not signed in to Cloudflare", hint: "Sign in with `cms login`, or set CLOUDFLARE_API_TOKEN.", next: ["cms login"] } };
  }
  return { identity, check: { id: "auth", status: "pass", title: "Signed in", detail: identity.source?.label } };
}

/** Checks that need the account: resources, secrets, migrations, plugin settings. */
async function accountChecks(ctx: Ctx, port: CloudflarePort, site: Site, identity: Identity, cfVersion: string): Promise<Check[]> {
  const quiet: Ctx = { ...ctx, interactive: false };
  let account;
  try {
    account = await chooseAccount(quiet, identity, site.accountId);
  } catch (e) {
    if (!isCliError(e)) throw e;
    return [errorCheck("account", "Account", e)];
  }
  const data = await ctx.progress("Reading Cloudflare", () =>
    gatherStatus(ctx, { site, reads: port.account(account.id), account, auth: identity.source ?? { kind: "other", label: "" }, cfVersion }),
  );
  const logs: Check = site.logsEnabled
    ? { id: "logs", status: "pass", title: "Workers Logs", detail: "enabled" }
    : { id: "logs", status: "warn", title: "Workers Logs", detail: "not enabled; cms logs --since has nothing to read", hint: 'Add "observability": { "enabled": true } to wrangler.jsonc and deploy. The live tail (cms logs) works without it.' };
  return [
    { id: "account", status: "pass", title: "Account", detail: account.name },
    ...siteChecks(data),
    logs,
    ...(await settingsChecks(site.dir, site.configPath, data.secrets.names)),
  ];
}

async function remoteChecks(ctx: Ctx, site: Site | undefined): Promise<Check[]> {
  const port = ctx.cloudflare();
  const ready = await port.readiness();
  const checks = [cfCheck(ready, port.installPlan().display)];
  if (ready.state !== "ready") return checks;
  try {
    const auth = await authCheck(port);
    checks.push(auth.check);
    if (auth.identity && site) checks.push(...(await accountChecks(ctx, port, site, auth.identity, ready.version)));
  } catch (e) {
    if (!(e instanceof CloudflareError) && !isCliError(e)) throw e;
    checks.push(errorCheck("cloudflare", "Cloudflare", toCliError(e, againCommand(ctx))));
  }
  return checks;
}

const MARK: Record<Check["status"], (s: StyleSet) => string> = {
  pass: (s) => s.green("✓"),
  warn: (s) => s.yellow("!"),
  fail: (s) => s.red("✗"),
};

export function renderDoctor(checks: readonly Check[], s: StyleSet): string {
  const width = Math.max(...checks.map((c) => c.title.length)) + 3;
  const lines = checks.flatMap((c) => [
    `${MARK[c.status](s)}  ${padVisual(c.title, width)}${c.detail ?? ""}`.trimEnd(),
    ...(c.status !== "pass" && c.hint ? [`   ${c.hint}`] : []),
    ...(c.status !== "pass" ? (c.next ?? []).map((n) => `   ${s.dim("next:")} ${n}`) : []),
  ]);
  const count = (status: Check["status"]) => checks.filter((c) => c.status === status).length;
  return [...lines, "", `${count("pass")} passed, ${count("warn")} warnings, ${count("fail")} failed`].join("\n");
}

export async function runDoctor(ctx: Ctx): Promise<Outcome> {
  const { site, check } = await siteCheck(ctx);
  const checks = [nodeCheck(ctx.io.nodeVersion), check, ...(await remoteChecks(ctx, site))];
  const failed = checks.filter((c) => c.status === "fail");
  const data = { checks, summary: { pass: checks.length - failed.length - checks.filter((c) => c.status === "warn").length, warn: checks.filter((c) => c.status === "warn").length, fail: failed.length } };
  const error =
    failed.length > 0
      ? new CliError({
          code: "CHECKS_FAILED",
          message: `${failed.length} ${failed.length === 1 ? "check" : "checks"} failed.`,
          next: [...new Set(failed.flatMap((c) => c.next ?? []))],
        })
      : undefined;
  return { data, text: renderDoctor(checks, ctx.out), error };
}
