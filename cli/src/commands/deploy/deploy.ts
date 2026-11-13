// `cms deploy`: read, show the plan, ask, apply. `--dry-run` stops after the plan
// and returns it as plan[]; `--yes` accepts it; answering No changes nothing (130).

import type { Ctx, Outcome, PlanItem } from "../../frame/context.js";
import { CliError } from "../../frame/errors.js";
import { toCliError } from "../../frame/output.js";
import { againCommand } from "../connect.js";
import { apply, stateOf, type Progress } from "./apply.js";
import { inspect, type Inspection } from "./inspect.js";
import { buildPlan, renderPlan } from "./plan.js";
import { DeployLog, Steps } from "./steps.js";

function summary(i: Inspection, plan: PlanItem[]) {
  return {
    mode: i.workerExists ? "update" : "first-deploy",
    worker: i.site.workerName,
    account: { id: i.account.id, name: i.account.name, from: i.account.from },
    wranglerSignedIn: i.wranglerSignedIn,
    changes: plan.length,
  };
}

function wranglerWarnings(ctx: Ctx, i: Inspection): void {
  if (i.wranglerSignedIn === null) ctx.warn("DEPENDENCIES_NOT_INSTALLED", "The project's dependencies are not installed; wrangler's sign-in is checked after cms deploy installs them.");
  if (i.wranglerSignedIn === false && !ctx.interactive) {
    throw new CliError({
      code: "AUTH_REQUIRED",
      message: "wrangler (it builds and uploads the Worker) is not signed in.",
      hint: "Run `pnpm exec wrangler login`, or set CLOUDFLARE_API_TOKEN (both cf and wrangler use it).",
      next: ["pnpm exec wrangler login", againCommand(ctx)],
    });
  }
  if (i.wranglerSignedIn === false) ctx.warn("WRANGLER_SIGNED_OUT", "wrangler is not signed in; cms deploy offers its login before building.");
}

async function confirm(ctx: Ctx, plan: PlanItem[]): Promise<void> {
  if (ctx.values.yes === true) return;
  if (!ctx.interactive) {
    throw new CliError({
      code: "CONFIRMATION_REQUIRED",
      message: `The plan has ${plan.length} changes and nobody can confirm them here.`,
      hint: "Read it with --dry-run, then run again with --yes.",
      next: [`${againCommand(ctx)} --dry-run`, `${againCommand(ctx)} --yes`],
      data: { plan },
    });
  }
  if (!(await ctx.prompt.confirm("Apply this plan?", true))) {
    throw new CliError({
      code: "CANCELLED",
      message: "Nothing was changed.",
      hint: "Run `cms deploy` again when you are ready. See the plan without being asked: cms deploy --dry-run",
    });
  }
}

function failed(e: unknown, progress: Progress, steps: Steps, again: string): CliError {
  const error = toCliError(e, again);
  const state = stateOf(progress);
  const data = { ...state, completed: steps.completed, log: steps.log.shown, ...(progress.uploaded ? { versionId: progress.uploaded } : {}) };
  return new CliError({
    code: error.code,
    message: error.message,
    hint: [error.hint, state.meaning].filter(Boolean).join(" "),
    next: [...error.next],
    data,
    exit: error.exit,
  });
}

export async function runDeploy(ctx: Ctx): Promise<Outcome> {
  const i = await inspect(ctx);
  wranglerWarnings(ctx, i);
  const plan = buildPlan(i);
  if (ctx.values["dry-run"] === true) {
    return { data: { ...summary(i, plan), dryRun: true }, plan, text: [...renderPlan(plan, ctx.out), "", "   Dry run: nothing was changed."].join("\n") };
  }
  if (!ctx.json) ctx.say(["", ...renderPlan(plan, ctx.err), ""].join("\n"));
  await confirm(ctx, plan);
  const steps = new Steps(ctx, new DeployLog(i.site.dir, ctx.io.now()), againCommand(ctx));
  const progress: Progress = { config: false, resources: false, migrated: false, live: false };
  try {
    const result = await apply(ctx, steps, i, progress);
    const notes = result.siteUrlInitialized ? ["", `core.siteUrl was set to ${result.origin}. After attaching a custom domain, run cms deploy --site-url https://your-domain or change it in Settings.`] : [];
    return {
      data: { ...summary(i, plan), ...result, url: result.origin, steps: steps.completed, log: steps.log.shown },
      plan,
      text: [`   ${result.origin}`, ...notes].join("\n"),
    };
  } catch (e) {
    throw failed(e, progress, steps, againCommand(ctx));
  } finally {
    steps.close();
  }
}
