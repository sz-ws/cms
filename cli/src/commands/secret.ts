// `cms secret list | set <NAME> | delete <NAME>`: the Worker's secrets, through cf.
// A value comes from stdin or a hidden prompt, never from a flag, and no output
// ever contains one. The three managed secrets are refused here (exit 4):
// SECRETS_KEY and AUTH_PEPPER can never change without breaking the site, and
// SETUP_TOKEN keeps the managed rule (generated when missing, never rotated).

import type { AccountApi } from "../cloudflare/port.js";
import type { Ctx, Outcome, PlanItem } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { MANAGED_SECRETS } from "../secrets.js";
import { readSite } from "../site/site.js";
import { connect } from "./connect.js";
import { confirmPlan } from "./confirm.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const WHY: Record<string, string> = {
  SECRETS_KEY: "It encrypts every stored secret setting; a new value turns them all into unreadable data.",
  AUTH_PEPPER: "It is part of every password hash; a new value or none locks every account out.",
  SETUP_TOKEN: "It is generated once and never rotated; a site without an administrator could lock itself out.",
};

async function siteApi(ctx: Ctx): Promise<{ worker: string; api: AccountApi }> {
  const site = await readSite(ctx.cwd, String(ctx.values.config));
  const { port, account } = await connect(ctx, site.accountId);
  return { worker: site.workerName, api: port.account(account.id) };
}

async function names(api: AccountApi, worker: string): Promise<string[]> {
  const list = await api.secretNames(worker);
  if (list === null) {
    throw new CliError({ code: "WORKER_NOT_FOUND", message: `The Worker ${worker} does not exist yet, so it has no secrets.`, next: ["cms deploy"] });
  }
  return list;
}

function nameArgument(ctx: Ctx): string {
  const name = ctx.positionals[0] ?? "";
  if (!NAME_RE.test(name)) throw new CliError({ code: "BAD_VALUE", message: `"${name}" is not a secret name (letters, digits and _; not starting with a digit).`, next: [`cms ${ctx.spec.name} MY_SECRET`] });
  if (MANAGED_SECRETS.some((m) => m.name === name)) {
    throw new CliError({
      code: "MANAGED_SECRET",
      message: `${name} is managed by cms and is not changed or deleted by hand.`,
      hint: `${WHY[name]} cms deploy (or cms secrets) creates it only when it is missing.`,
      next: ["cms secret list"],
    });
  }
  return name;
}

export async function runSecretList(ctx: Ctx): Promise<Outcome> {
  const { worker, api } = await siteApi(ctx);
  const list = (await ctx.progress("Reading secrets", () => names(api, worker))).sort();
  const managed = new Set(MANAGED_SECRETS.map((m) => m.name));
  const rows = list.map((name) => ({ name, managed: managed.has(name) }));
  const text = rows.length === 0 ? `${worker} has no secrets.` : rows.map((r) => `${r.name}${r.managed ? "  (managed by cms)" : ""}`).join("\n");
  return { data: { worker, secrets: rows }, text };
}

async function secretValue(ctx: Ctx, name: string): Promise<string> {
  if (!ctx.io.stdinTty) return (await ctx.readStdin()).replace(/\r?\n$/, "");
  if (!ctx.interactive) {
    throw new CliError({ code: "INPUT_REQUIRED", message: `The value of ${name} comes from stdin.`, hint: `Pipe it in: printf %s "$VALUE" | cms secret set ${name}`, next: [`cms secret set ${name}`] });
  }
  return ctx.prompt.secret(`Value of ${name}`);
}

export async function runSecretSet(ctx: Ctx): Promise<Outcome> {
  const name = nameArgument(ctx);
  const { worker, api } = await siteApi(ctx);
  const exists = (await names(api, worker)).includes(name);
  const plan: PlanItem[] = [{ action: exists ? "replace" : "create", type: "secret", name }];
  const data = { worker, name, replaced: exists };
  if (ctx.values["dry-run"] === true) return { data: { ...data, dryRun: true }, plan, text: `Would ${exists ? "replace" : "set"} ${name} on ${worker}.` };
  if (exists) await confirmPlan(ctx, plan, `${name} already exists on ${worker}. Replace its value?`);
  const value = await secretValue(ctx, name);
  if (value === "") throw new CliError({ code: "BAD_VALUE", message: `The value of ${name} is empty; nothing was set.`, next: [`cms secret set ${name}`] });
  await ctx.progress(`Setting ${name}`, () => api.putSecret(worker, name, value));
  return { data, plan, text: `${exists ? "Replaced" : "Set"} ${name} on ${worker}. It applies to the live Worker now.` };
}

export async function runSecretDelete(ctx: Ctx): Promise<Outcome> {
  const name = nameArgument(ctx);
  const { worker, api } = await siteApi(ctx);
  if (!(await names(api, worker)).includes(name)) {
    throw new CliError({ code: "SECRET_NOT_FOUND", message: `${worker} has no secret named ${name}.`, next: ["cms secret list"] });
  }
  const plan: PlanItem[] = [{ action: "delete", type: "secret", name }];
  if (ctx.values["dry-run"] === true) return { data: { worker, name, dryRun: true }, plan, text: `Would delete ${name} from ${worker}.` };
  await confirmPlan(ctx, plan, `Delete ${name} from ${worker}? Code that reads it will see it missing.`);
  await ctx.progress(`Deleting ${name}`, () => api.deleteSecret(worker, name));
  return { data: { worker, name }, plan, text: `Deleted ${name} from ${worker}.` };
}
