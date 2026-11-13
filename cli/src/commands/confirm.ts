// The one way a command that changes things asks first: --yes accepts, a person
// confirms in a terminal, anything else stops with CONFIRMATION_REQUIRED (exit 3).
// Answering No changes nothing and exits 130.

import type { Ctx, PlanItem } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { againCommand } from "./connect.js";

export function withFlag(command: string, flag: string): string {
  return command.split(" ").includes(flag) ? command : `${command} ${flag}`;
}

export async function confirmPlan(ctx: Ctx, plan: readonly PlanItem[], question = "Apply this plan?"): Promise<void> {
  if (ctx.values.yes === true) return;
  const again = againCommand(ctx);
  if (!ctx.interactive) {
    throw new CliError({
      code: "CONFIRMATION_REQUIRED",
      message: `The plan has ${plan.length} ${plan.length === 1 ? "change" : "changes"} and nobody can confirm them here.`,
      hint: "Read it with --dry-run, then run again with --yes.",
      next: [withFlag(again, "--dry-run"), withFlag(again, "--yes")],
      data: { plan },
    });
  }
  if (!(await ctx.prompt.confirm(question, true))) {
    throw new CliError({
      code: "CANCELLED",
      message: "Nothing was changed.",
      hint: `Run \`${again}\` again when you are ready. See the plan without being asked: ${withFlag(again, "--dry-run")}`,
    });
  }
}
