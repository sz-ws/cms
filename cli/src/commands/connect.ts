// Getting from "nothing" to "signed in, account chosen": cf present and recent
// enough, a Cloudflare login, one account. Interactive runs ask once at each step;
// non-interactive runs fail at once with the error code and the command to run.
//
// What answering No means is fixed (see the approved preview):
//   install cf?        → exit 3, the install command printed
//   open the browser?  → exit 3, CLOUDFLARE_API_TOKEN explained
//   which account?     → Ctrl-C cancels, exit 130; nothing is written

import { existsSync } from "node:fs";
import path from "node:path";
import { CF_MIN, CF_TESTED } from "../cloudflare/cf-binary.js";
import type { AccountRef, CloudflarePort, Identity, Readiness } from "../cloudflare/port.js";
import type { Ctx } from "../frame/context.js";
import { CliError } from "../frame/errors.js";

export function againCommand(ctx: Ctx): string {
  return `cms ${ctx.spec.name}${ctx.json ? " --json" : ""}`;
}

function missingCf(ctx: Ctx, plan: string): CliError {
  return new CliError({
    code: "CF_MISSING",
    message: "cf (Cloudflare's CLI) is not installed.",
    hint: "cms uses it to talk to Cloudflare. Install it, then run the command again.",
    next: [plan, againCommand(ctx)],
  });
}

function hasPackageJson(dir: string): boolean {
  return existsSync(path.join(dir, "package.json"));
}

async function offerInstall(ctx: Ctx, port: CloudflarePort): Promise<Readiness> {
  const plan = port.installPlan();
  if (!ctx.interactive || !hasPackageJson(ctx.cwd)) throw missingCf(ctx, plan.display);
  ctx.say(`${ctx.err.yellow("!")}  cf (Cloudflare's CLI) is not installed.`);
  ctx.say("   cms uses it to talk to Cloudflare.");
  if (!(await ctx.prompt.confirm(`Install it now? (${plan.display})`, true))) throw missingCf(ctx, plan.display);
  const installed = await port.install();
  const after = await port.readiness();
  if (!installed || after.state !== "ready") {
    throw new CliError({ code: "CF_INSTALL_FAILED", message: `Installing cf failed (${plan.display}).`, next: [plan.display] });
  }
  ctx.say(`${ctx.err.green("✓")}  Installed cf ${after.version}`);
  return after;
}

/** cf is installed and supported, or a CliError says what to do. */
export async function ensureCf(ctx: Ctx, port: CloudflarePort): Promise<Extract<Readiness, { state: "ready" }>> {
  let r = await port.readiness();
  if (r.state === "node-too-old") {
    throw new CliError({
      code: "NODE_TOO_OLD",
      message: `cf (Cloudflare's CLI) needs Node 22 or newer; this is Node ${r.node}.`,
      hint: "Upgrade Node, then run the command again.",
      next: [againCommand(ctx)],
    });
  }
  if (r.state === "unsupported") {
    throw new CliError({
      code: "CF_VERSION_UNSUPPORTED",
      message: `cf ${r.version} is older than this CLI supports (${CF_MIN} or newer).`,
      hint: "Update cf, then run the command again.",
      next: [port.installPlan().display, againCommand(ctx)],
    });
  }
  if (r.state === "missing") r = await offerInstall(ctx, port);
  if (r.state !== "ready") throw missingCf(ctx, port.installPlan().display);
  if (r.untested) {
    ctx.warn("CF_VERSION_UNTESTED", `cf ${r.version} is newer than the release this CLI was tested with (${CF_TESTED}). If a command fails, install cf@${CF_TESTED}.`);
  }
  return r;
}

function authRequired(): CliError {
  return new CliError({
    code: "AUTH_REQUIRED",
    message: "Not signed in to Cloudflare.",
    hint: "Run `cms login` in a terminal, or set CLOUDFLARE_API_TOKEN to an API token (for CI and agents).",
    next: ["cms login"],
  });
}

/** Run cf's browser login with the terminal handed over, then read the identity again. */
export async function runLogin(ctx: Ctx, port: CloudflarePort): Promise<Identity> {
  const ok = await port.login();
  const identity = ok ? await port.whoami() : undefined;
  if (!identity?.authenticated) {
    throw new CliError({ code: "LOGIN_FAILED", message: "Signing in to Cloudflare did not complete.", next: ["cms login"] });
  }
  ctx.say(`${ctx.err.green("✓")}  Signed in${identity.email ? ` as ${identity.email}` : ""}`);
  return identity;
}

export async function ensureSignedIn(ctx: Ctx, port: CloudflarePort): Promise<Identity> {
  const identity = await port.whoami();
  if (identity.authenticated) return identity;
  if (!ctx.interactive) throw authRequired();
  ctx.say(`${ctx.err.yellow("!")}  Not signed in to Cloudflare.`);
  if (!(await ctx.prompt.confirm("Sign in now? (cf shows a code to approve in any browser)", true))) {
    throw new CliError({
      code: "AUTH_REQUIRED",
      message: "Not signed in to Cloudflare.",
      hint: "Run `cms login` when you are ready: cf shows a code to approve in any browser. For CI and agents, set CLOUDFLARE_API_TOKEN.",
      next: ["cms login", againCommand(ctx)],
    });
  }
  return runLogin(ctx, port);
}

export type AccountSource = "flag" | "env" | "config" | "only-account" | "chosen";

export interface ChosenAccount extends AccountRef {
  from: AccountSource;
}

function ambiguous(ctx: Ctx, accounts: readonly AccountRef[]): CliError {
  return new CliError({
    code: "ACCOUNT_AMBIGUOUS",
    message:
      accounts.length === 0
        ? "No Cloudflare account is visible to this login, and none is set."
        : `This login can see ${accounts.length} Cloudflare accounts, and none is chosen.`,
    hint: "Pass --account <id>, set CLOUDFLARE_ACCOUNT_ID, or add account_id to wrangler.jsonc.",
    next: accounts.slice(0, 5).map((a) => `cms ${ctx.spec.name} --account ${a.id}`),
    data: { accounts },
  });
}

/** --account, then CLOUDFLARE_ACCOUNT_ID, then account_id in wrangler.jsonc, then the only account. */
export async function chooseAccount(ctx: Ctx, identity: Identity, configAccount: string | undefined): Promise<ChosenAccount> {
  const given = typeof ctx.values.account === "string" ? ctx.values.account : undefined;
  const pick = (id: string, from: AccountSource): ChosenAccount => ({
    id,
    name: identity.accounts.find((a) => a.id === id)?.name ?? id,
    from,
  });
  if (given) return pick(given, ctx.explicit.has("account") ? "flag" : "env");
  if (configAccount) return pick(configAccount, "config");
  if (identity.accounts.length === 1) return pick(identity.accounts[0].id, "only-account");
  if (!ctx.interactive || identity.accounts.length === 0) throw ambiguous(ctx, identity.accounts);
  const id = await ctx.prompt.select(
    `This login can see ${identity.accounts.length} accounts. Which one?`,
    identity.accounts.map((a) => ({ label: a.name, value: a.id, hint: a.id })),
  );
  ctx.say(`   Next time: --account ${id}, or account_id in wrangler.jsonc`);
  return pick(id, "chosen");
}

/** The whole connection: cf, login, account. */
export async function connect(
  ctx: Ctx,
  configAccount: string | undefined,
): Promise<{ port: CloudflarePort; cf: Extract<Readiness, { state: "ready" }>; identity: Identity; account: ChosenAccount }> {
  const port = ctx.cloudflare();
  const cf = await ensureCf(ctx, port);
  const identity = await ensureSignedIn(ctx, port);
  const account = await chooseAccount(ctx, identity, configAccount);
  return { port, cf, identity, account };
}
